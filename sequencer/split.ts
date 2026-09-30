import { rmSync } from 'node:fs'
import { LANE } from '../cli/plan.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, planById, type PlanRow, rewind } from '../store/plans.ts'
import type { SignalRow } from '../store/signals.ts'
import type { Part } from './brief.ts'
import type { Outcome } from './kind.ts'
import { WIRE, type Wire } from './push.ts'
import { drop, get, put, srcDir } from './workspace.ts'
import { homeOf } from './home.ts'
import { approved } from './approve.ts'
import { words } from './signals.ts'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * Every part becomes an issue of ours, titled `<parent><letter>: …` in the order the parts
 * land, carrying the parent's lane; every part with no `after` is queued at the parent's priority and the parent's
 * issue says where its work went. The parent plan ends here with no build. A split of somebody else's
 * approved ticket is filed on our repo as internal-only parts titled `p<plan><letter>: …` that build against
 * `asm/<plan>`; an unapproved one is not the machine's to file: the parts wait for a person instead.
 * Filing is resumable -- a part already on file is not filed twice -- so a `gh` that fails half way is
 * a blip the next tick finishes.
 */
export function parted(db: Db, root: string, plan: PlanRow, parts: Part[], wire: Wire = WIRE): Outcome {
  const why = unfileable(db, plan)
  if (why !== null) {
    put(root, plan.id, 'question.md', `${why}. The brief writer's parts, in landing order, for the COO to file or refuse:\n\n${parts.map(render).join('\n\n')}\n`)
    drop(root, plan.id, 'split.md')
    return { outcome: 'needs_ceo', spans: ['split'], note: `${why}: ${String(parts.length)} parts wait for the COO` }
  }
  const parent = originIssue(plan)
  try {
    const urls = [...parts.keys()].map((n) => filed(db, plan, parent === null ? `p${String(plan.id)}` : String(parent), parts, n, wire))
    const on = (n: number): string => ref(urls[n] ?? '')
    const started = [...parts.keys()].filter((n) => parts[n]?.after === 'none')
    for (const n of started) queue(db, root, plan, n)
    const waits = parts.flatMap((p, n) => p.after === 'none' ? [] : [`${on(n)} waits on ${on(LETTERS.indexOf(p.after))}`])
    if (parent !== null) {
      wire.comment(homeOf(plan), parent, `The brief writer found this is ${String(parts.length)} jobs, not one: ${urls.map(ref).join(', ')}. ${[`${started.map(on).join(', ')} started`, ...waits].join('; ')}. This issue closes when every one lands.`)
    }
    return { outcome: 'pass', spans: [], split: true, note: `split into ${urls.map(ref).join(', ')}; ${started.map(on).join(', ')} queued` }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: 'refuse', spans: ['gh'], blip: true, note: `split: ${note}` }
  }
}

/**
 * After a part lands on main: the parts that wait on it are queued, or, every other part landed, the parent's issue is
 * closed with the sha that finished it. Only the close touches the network, and a close that fails is
 * said in the note rather than undoing a landing.
 */
export function following(db: Db, root: string, plan: PlanRow, sha: string, wire: Wire = WIRE): string | null {
  const row = db.prepare('SELECT parent, n FROM parts WHERE plan = ?').get(plan.id) as { parent: number; n: number } | undefined
  if (row === undefined) return null
  const parent = planById(db, row.parent)
  const waiting = db.prepare('SELECT n FROM parts WHERE parent = ? AND after = ? AND plan IS NULL').all(parent.id, row.n) as { n: number }[]
  if (waiting.length > 0) return waiting.map(({ n }) => `part ${letter(n)} queued as plan ${String(queue(db, root, parent, n))}`).join('; ')
  const rest = db.prepare('SELECT plan FROM parts WHERE parent = ? AND n != ?').all(parent.id, row.n) as { plan: number | null }[]
  if (!rest.every((p) => landed(db, p.plan))) return null
  const issue = originIssue(parent)
  if (issue === null) return assemble(db, root, parent)
  const closed = close(parent, issue, sha, wire)
  const up = following(db, root, parent, sha, wire)
  return up === null ? closed : `${closed}; ${up}`
}

/** A split part is `done` from the moment it splits, so it lands only when its own parts have. */
function landed(db: Db, plan: number | null): boolean {
  if (plan === null) return false
  const row = db.prepare('SELECT state FROM plans WHERE id = ?').get(plan) as { state: string }
  const parts = db.prepare('SELECT plan FROM parts WHERE parent = ?').all(plan) as { plan: number | null }[]
  return row.state === 'done' && parts.every((p) => landed(db, p.plan))
}

/** An outside parent goes back to senior on its checkout of `asm/<id>`, to be sent upstream as one change. */
function assemble(db: Db, root: string, parent: PlanRow): string {
  const branch = `asm/${String(parent.id)}`
  const titles = db.prepare('SELECT title FROM parts WHERE parent = ? ORDER BY n').all(parent.id) as { title: string }[]
  put(root, parent.id, 'issue.md', [get(root, parent.id, 'ask.md').trimEnd(), '', `## Parts, joined on ${branch}`, '',
    ...titles.map((p) => `- ${p.title}`), '', '## Cases', '', `- D1 every part's cases hold together on ${branch}`,
    '- D2 a gap between parts is refused: a case no part answers, a name one part adds and no part uses, a change two parts make twice', ''].join('\n'))
  rmSync(srcDir(root, parent.id), { recursive: true, force: true })
  rewind(db, parent.id, 5)
  return `the last part landed; plan ${String(parent.id)} assembles ${branch} at senior`
}

function close(plan: PlanRow, issue: number, sha: string, wire: Wire): string {
  try {
    wire.close(homeOf(plan), issue, sha)
    return `the last part landed; #${String(issue)} closed`
  } catch (error) {
    return `the last part landed; closing #${String(issue)} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** A part's own split filed by a person as `<part issue><letter>: …` joins the part's plan as the machine's would. */
export function claimed(db: Db, root: string, issue: { url: string; title: string; body: string }): boolean {
  const [, no, at] = /^(\d+)([a-z])\b/.exec(issue.title) ?? []
  if (no === undefined || at === undefined) return false
  const row = db.prepare('SELECT plan FROM parts WHERE url = ? AND plan IS NOT NULL').get(issue.url.replace(/\d+$/, no)) as
    { plan: number } | undefined
  if (row === undefined) return false
  const n = LETTERS.indexOf(at)
  db.prepare('INSERT INTO parts (parent, n, url, title, body, after) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.plan, n, issue.url, issue.title, issue.body, n === 0 ? null : n - 1)
  queue(db, root, planById(db, row.plan), 0)
  return true
}

/** Why a split cannot be filed by the machine, or null when it can. */
function unfileable(db: Db, plan: PlanRow): string | null {
  if (internal(plan)) return originIssue(plan) === null ? 'the plan names no issue of ours to split' : null
  return approved(db, plan) ? null : 'an unapproved ticket on somebody else\'s repository is split by the COO, not the machine'
}

function filed(db: Db, plan: PlanRow, prefix: string, parts: Part[], n: number, wire: Wire): string {
  const held = db.prepare('SELECT url FROM parts WHERE parent = ? AND n = ?').get(plan.id, n) as { url: string } | undefined
  if (held !== undefined) return held.url
  const part = parts[n]
  if (part === undefined) throw new Error(`no part ${String(n)}`)
  const after = part.after === 'none' ? null : LETTERS.indexOf(part.after)
  const prior = after === null ? undefined
    : (db.prepare('SELECT url FROM parts WHERE parent = ? AND n = ?').get(plan.id, after) as { url: string } | undefined)?.url
  const title = `${prefix}${letter(n)}: ${part.title}`
  const of = `${letter(n)} of ${String(parts.length)}`
  const id = String(plan.id)
  const body = [`**What:** ${part.what}`, `**Why:** ${part.why}`, `**When it ends:** ${part.ends}`, '',
    internal(plan) ? `Part ${of} of #${prefix}, split by the brief writer.`
      : `Internal only: part ${of} of plan ${id}, split by the brief writer; it builds against asm/${id} on our fork and opens no pull request upstream.`,
    ...(prior === undefined ? [] : [`After: ${ref(prior)}`]), ''].join('\n')
  const url = wire.file(homeOf(plan), title, body, labels(plan))
  db.prepare('INSERT INTO parts (parent, n, url, title, body, after) VALUES (?, ?, ?, ?, ?, ?)').run(plan.id, n, url, title, body, after)
  return url
}

/** Intake re-prices a plan from its issue's P label, so a part filed without one falls to the default. */
function labels(plan: PlanRow): string[] {
  return [...(plan.lane === null ? [] : [`lane:${plan.lane}`]), `P${String(plan.priority)}`]
}

/** A requested change on an assembled pull request, filed and queued as one more internal part on `asm/<parent>`; returns its plan. */
export function fixed(db: Db, root: string, parent: PlanRow, signal: SignalRow, wire: Wire): number {
  const { n } = db.prepare('SELECT count(*) AS n FROM parts WHERE parent = ?').get(parent.id) as { n: number }
  const id = String(parent.id)
  const title = `p${id}${letter(n)}: address ${signal.author}'s review on ${signal.repo}#${String(signal.pr)}`
  const body = `${words(signal)}\nInternal only: a fix of plan ${id}; it builds against asm/${id} on our fork and opens no pull request upstream.\n`
  const url = wire.file(homeOf(parent), title, body, labels(parent))
  db.prepare('INSERT INTO parts (parent, n, url, title, body, after) VALUES (?, ?, ?, ?, ?, NULL)').run(parent.id, n, url, title, body)
  return made(db, root, parent, n, { url, title, body })
}

/** A part whose `After:` issue is closed, however it closed, is queued; `open` is every open issue number of `repo`. */
export function released(db: Db, root: string, repo: string, open: Set<number>): void {
  const rows = db.prepare(`SELECT p.parent, p.n, t.after FROM parts p
    JOIN tickets t ON p.url = 'https://github.com/' || t.repo || '/issues/' || t.number
    WHERE p.plan IS NULL AND t.repo = ? AND t.after IS NOT NULL AND t.closed_at IS NULL`).all(repo) as { parent: number; n: number; after: number }[]
  for (const row of rows.filter((r) => !open.has(r.after))) {
    const id = queue(db, root, planById(db, row.parent), row.n)
    if (id !== null) {
      logged(db, { plan: id, kind: 'unblocked', actor: 'split', outcome: 'pass', message: `#${String(row.after)} closed`, pointer: null, run: null })
    }
  }
}

/** A part's plan is the parent's in every setting but its issue: same pipe, target, lane, seat and priority; an outside parent has no lane or seat, so its part takes the machine lane's. */
function queue(db: Db, root: string, parent: PlanRow, n: number): number | null {
  const row = db.prepare('SELECT url, title, body, plan FROM parts WHERE parent = ? AND n = ?').get(parent.id, n) as
    { url: string; title: string; body: string; plan: number | null } | undefined
  if (row === undefined) return null
  if (row.plan !== null) return row.plan
  return made(db, root, parent, n, row)
}

function made(db: Db, root: string, parent: PlanRow, n: number, row: { url: string; title: string; body: string }): number {
  const inserted = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(parent.pipe_id, parent.target_id, parent.template, new Date().toISOString(), parent.priority,
      parent.lane ?? 'machine', parent.seat ?? LANE.machine.seat, row.url)
  const id = Number(inserted.lastInsertRowid)
  logged(db, { plan: id, kind: 'filed', actor: 'split', outcome: 'pass', message: row.url, pointer: null, run: null })
  db.prepare('UPDATE parts SET plan = ? WHERE parent = ? AND n = ?').run(id, parent.id, n)
  put(root, id, 'ask.md', `# ${row.title}\n\n${row.body}`)
  return id
}

function render(part: Part, n: number): string {
  return `${letter(n)}. ${part.title}\n**What:** ${part.what}\n**Why:** ${part.why}\n**When it ends:** ${part.ends}`
}

function letter(n: number): string {
  return LETTERS[n] ?? String(n)
}

function ref(url: string): string {
  return `#${url.split('/').at(-1) ?? ''}`
}
