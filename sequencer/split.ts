import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, PlanRow } from '../store/plans.ts'
import type { Part } from './brief.ts'
import type { Outcome } from './kind.ts'
import { WIRE, type Wire } from './push.ts'
import { drop, put } from './workspace.ts'
import { homeOf } from './home.ts'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * #72, filed. Every part becomes an issue of ours, titled `<parent><letter>: …` in the order the parts
 * land, carrying the parent's lane; the first is queued at the parent's priority and the parent's
 * issue says where its work went. The parent plan ends here with no build. A split of somebody else's
 * ticket is not the machine's to file: the parts wait for the COO instead.
 * Filing is resumable -- a part already on file is not filed twice -- so a `gh` that fails half way is
 * a blip the next tick finishes.
 */
export function parted(db: Db, root: string, plan: PlanRow, parts: Part[], wire: Wire = WIRE): Outcome {
  const parent = originIssue(plan)
  const why = unfileable(plan, parent)
  if (why !== null || parent === null) {
    const said = why ?? 'the plan names no issue of ours'
    put(root, plan.id, 'question.md', `${said}. The brief writer's parts, in landing order, for the COO to file or refuse:\n\n${parts.map(render).join('\n\n')}\n`)
    drop(root, plan.id, 'split.md')
    return { outcome: 'needs_ceo', spans: ['split'], note: `${said}: ${String(parts.length)} parts wait for the COO` }
  }
  try {
    const urls = [...parts.keys()].map((n) => filed(db, plan, parent, parts, n, wire))
    queue(db, root, plan, 0)
    wire.comment(homeOf(plan), parent, `The brief writer found this is ${String(parts.length)} jobs, not one. They land in this order: ${urls.map(ref).join(', ')}. The first is queued; each one that lands queues the next, and this issue closes when the last one lands.`)
    return { outcome: 'pass', spans: [], split: true, note: `split into ${urls.map(ref).join(', ')}; ${ref(urls[0] ?? '')} queued` }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: 'refuse', spans: ['gh'], blip: true, note: `split: ${note}` }
  }
}

/**
 * After a part lands on main: the next part is queued, or, the last one landed, the parent's issue is
 * closed with the sha that finished it. Only the close touches the network, and a close that fails is
 * said in the note rather than undoing a landing.
 */
export function following(db: Db, root: string, plan: PlanRow, sha: string, wire: Wire = WIRE): string | null {
  const row = db.prepare('SELECT parent, n FROM parts WHERE plan = ?').get(plan.id) as { parent: number; n: number } | undefined
  if (row === undefined) return null
  const parent = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(row.parent))
  const next = queue(db, root, parent, row.n + 1)
  if (next !== null) return `part ${letter(row.n + 1)} queued as plan ${String(next)}`
  const issue = originIssue(parent)
  if (issue === null) return 'the last part landed'
  const closed = close(parent, issue, sha, wire)
  const up = following(db, root, parent, sha, wire)
  return up === null ? closed : `${closed}; ${up}`
}

function close(plan: PlanRow, issue: number, sha: string, wire: Wire): string {
  try {
    wire.close(homeOf(plan), issue, sha)
    return `the last part landed; #${String(issue)} closed`
  } catch (error) {
    return `the last part landed; closing #${String(issue)} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** A part's own split filed by the COO as `<part issue><letter>: …` joins the part's plan as the machine's would. */
export function claimed(db: Db, root: string, issue: { url: string; title: string; body: string }): boolean {
  const [, no, at] = /^(\d+)([a-z])\b/.exec(issue.title) ?? []
  if (no === undefined || at === undefined) return false
  const row = db.prepare('SELECT plan FROM parts WHERE url = ? AND plan IS NOT NULL').get(issue.url.replace(/\d+$/, no)) as
    { plan: number } | undefined
  if (row === undefined) return false
  db.prepare('INSERT INTO parts (parent, n, url, title, body) VALUES (?, ?, ?, ?, ?)')
    .run(row.plan, LETTERS.indexOf(at), issue.url, issue.title, issue.body)
  queue(db, root, PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(row.plan)), 0)
  return true
}

/** Why a split cannot be filed by the machine, or null when it can. */
function unfileable(plan: PlanRow, parent: number | null): string | null {
  if (!internal(plan)) return 'a ticket on somebody else\'s repository is split by the COO, not the machine'
  return parent === null ? 'the plan names no issue of ours to split' : null
}

function filed(db: Db, plan: PlanRow, parent: number, parts: Part[], n: number, wire: Wire): string {
  const held = db.prepare('SELECT url FROM parts WHERE parent = ? AND n = ?').get(plan.id, n) as { url: string } | undefined
  if (held !== undefined) return held.url
  const part = parts[n]
  if (part === undefined) throw new Error(`no part ${String(n)}`)
  const prior = n === 0 ? undefined
    : (db.prepare('SELECT url FROM parts WHERE parent = ? AND n = ?').get(plan.id, n - 1) as { url: string } | undefined)?.url
  const title = `${String(parent)}${letter(n)}: ${part.title}`
  const body = [`**What:** ${part.what}`, `**Why:** ${part.why}`, `**When it ends:** ${part.ends}`, '',
    `Part ${letter(n)} of ${String(parts.length)} of #${String(parent)}, split by the brief writer.`,
    ...(prior === undefined ? [] : [`After: ${ref(prior)}`]), ''].join('\n')
  // Intake re-prices a plan from its issue's P label, so a part filed without one fell to the default (9b ran P3 under a P0).
  const url = wire.file(homeOf(plan), title, body, [...(plan.lane === null ? [] : [`lane:${plan.lane}`]), `P${String(plan.priority)}`])
  db.prepare('INSERT INTO parts (parent, n, url, title, body) VALUES (?, ?, ?, ?, ?)').run(plan.id, n, url, title, body)
  return url
}

/** A part's plan is the parent's in every setting but its issue: same pipe, lane, seat and priority. */
function queue(db: Db, root: string, parent: PlanRow, n: number): number | null {
  const row = db.prepare('SELECT url, title, body, plan FROM parts WHERE parent = ? AND n = ?').get(parent.id, n) as
    { url: string; title: string; body: string; plan: number | null } | undefined
  if (row === undefined) return null
  if (row.plan !== null) return row.plan
  const made = db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(parent.pipe_id, parent.template, new Date().toISOString(), parent.priority, parent.lane, parent.seat, row.url)
  const id = Number(made.lastInsertRowid)
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
