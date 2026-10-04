import { rmSync } from 'node:fs'
import { mentions } from '../cli/gh.ts'
import { LANE } from '../cli/plan.ts'
import { deliverablesOf } from '../store/deliverables.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { addPart, claimedPart, partAt, partOf, partsOf, queuePart, releasable, waitingOn } from '../store/parts.ts'
import { internal, originIssue, planById, type PlanRow, rewind } from '../store/plans.ts'
import type { SignalRow } from '../store/signals.ts'
import { human, type Part, writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { languageOfPath, TEST } from './route.ts'
import { WIRE, type Wire } from './push.ts'
import { drop, get, maybe, put, srcDir } from './workspace.ts'
import { homeOf } from './home.ts'
import { approved } from './approve.ts'
import { words } from './signals.ts'

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const CUT = 6000

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
  const ask = maybe(root, plan.id, 'ask.md')
  const source = parent === null ? `plan ${String(plan.id)}` : `#${String(parent)}`
  const section = ask === null ? '' : carried(ask, '## Parent ticket', source)
  try {
    const thread = parent === null ? [] : wire.thread?.(homeOf(plan), parent) ?? []
    const said = thread.length === 0 ? '' : carried(thread.map((c) => `### ${c.author.login}\n\n${c.body.trim()}`).join('\n\n'), '## Parent comments', source)
    const cites = (p: Part): boolean => [p.title, p.what, p.why, p.ends].some((t) => (parent !== null && mentions(t, parent)) || thread.some((c) => t.includes(c.url)))
    const sections = parts.map((p) => [section, cites(p) ? said : ''].filter((s) => s !== '').join('\n\n'))
    const urls = [...parts.keys()].map((n) => filed(db, plan, parent === null ? `p${String(plan.id)}` : String(parent), parts, n, sections[n] ?? '', wire))
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
 * An outside brief whose files span languages, as the split fence of one part per language, each After the one before:
 * sources by language first, then tests, and files in no language with the first part. Null when it spans one.
 */
export function languages(plan: PlanRow, brief: string): string | null {
  if (internal(plan)) return null
  const paths = writable(brief).map((f) => f.path)
  const groups = new Map<string | null, string[]>()
  for (const path of [...paths.filter((p) => !TEST.test(p)), ...paths.filter((p) => TEST.test(p))]) {
    const language = languageOfPath(path) ?? (/\.[cm]?tsx?$/.test(path) ? 'typescript' : null)
    groups.set(language, [...groups.get(language) ?? [], path])
  }
  const parts = [...groups].filter((g): g is [string, string[]] => g[0] !== null)
  if (parts.length < 2) return null
  parts[0]?.[1].push(...groups.get(null) ?? [])
  const id = String(plan.id)
  const spans = parts.map(([language]) => language).join(' and ')
  return ['---', 'outcome: split', 'parts:', ...parts.flatMap(([language, files]) => [
    `  - title: ${language} part of ${human(brief).title ?? ''}`, `    what: plan ${id}'s ${language} files: ${files.join(', ')}`,
    `    why: plan ${id}'s brief spans ${spans}; each language has its own builder`,
    `    ends: every case of the brief those files answer holds on asm/${id}`]), '---', ''].join('\n')
}

/**
 * After a part lands on main: the parts that wait on it are queued, or, every other part landed, the parent's issue is
 * closed with the sha that finished it. Only the close touches the network, and a close that fails is
 * said in the note rather than undoing a landing.
 */
export function following(db: Db, root: string, plan: PlanRow, sha: string, wire: Wire = WIRE): string | null {
  const row = partOf(db, plan.id)
  if (row === undefined) return null
  const parent = planById(db, row.parent)
  const waiting = waitingOn(db, parent.id, row.n)
  if (waiting.length > 0) return waiting.map((n) => `part ${letter(n)} queued as plan ${String(queue(db, root, parent, n))}`).join('; ')
  const rest = partsOf(db, parent.id).filter((p) => p.n !== row.n)
  if (!rest.every((p) => landed(db, p.plan))) return null
  const issue = originIssue(parent)
  if (issue === null) return assemble(db, root, parent)
  const closed = close(parent, issue, sha, wire)
  const up = following(db, root, parent, sha, wire)
  return up === null ? closed : `${closed}; ${up}`
}

/** A `done` plan lands once its work is pushed; a split one is `done` from the moment it splits, so it lands only when its own parts have. */
export function landed(db: Db, plan: number | null): boolean {
  if (plan === null || planById(db, plan).state !== 'done') return false
  const parts = partsOf(db, plan)
  if (parts.length > 0) return parts.every((p) => landed(db, p.plan))
  return deliverablesOf(db, plan).some((d) => d.state === 'pushed')
}

/** An outside parent goes back to senior on its checkout of `asm/<id>`, to be sent upstream as one change. */
function assemble(db: Db, root: string, parent: PlanRow): string {
  const branch = `asm/${String(parent.id)}`
  put(root, parent.id, 'issue.md', [get(root, parent.id, 'ask.md').trimEnd(), '', `## Parts, joined on ${branch}`, '',
    ...partsOf(db, parent.id).map((p) => `- ${p.title}`), '', '## Cases', '', `- D1 every part's cases hold together on ${branch}`,
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
  const plan = claimedPart(db, issue.url.replace(/\d+$/, no))
  if (plan === null) return false
  const n = LETTERS.indexOf(at)
  addPart(db, { parent: plan, n, url: issue.url, title: issue.title, body: issue.body, after: n === 0 ? null : n - 1 })
  queue(db, root, planById(db, plan), 0)
  return true
}

/** Why a split cannot be filed by the machine, or null when it can. */
function unfileable(db: Db, plan: PlanRow): string | null {
  if (internal(plan)) return originIssue(plan) === null ? 'the plan names no issue of ours to split' : null
  return approved(db, plan) ? null : 'an unapproved ticket on somebody else\'s repository is split by the COO, not the machine'
}

/** The parent's ask or comments without an `After:` gate, which `afterOf` would read as the part's. */
function carried(ask: string, heading: string, source: string): string {
  const text = ask.replace(/^After: #\d+$\n?/gm, '')
  return `${heading}\n\n${text.length > CUT ? `${text.slice(0, CUT)}\ncut, see ${source}` : text.trimEnd()}`
}

function filed(db: Db, plan: PlanRow, prefix: string, parts: Part[], n: number, section: string, wire: Wire): string {
  const held = partAt(db, plan.id, n)
  if (held !== undefined) return held.url
  const part = parts[n]
  if (part === undefined) throw new Error(`no part ${String(n)}`)
  const after = part.after === 'none' ? null : LETTERS.indexOf(part.after)
  const prior = after === null ? undefined : partAt(db, plan.id, after)?.url
  const title = `${prefix}${letter(n)}: ${part.title}`
  const of = `${letter(n)} of ${String(parts.length)}`
  const id = String(plan.id)
  const body = [`**What:** ${part.what}`, `**Why:** ${part.why}`, `**When it ends:** ${part.ends}`, '',
    internal(plan) ? `Part ${of} of #${prefix}, split by the brief writer.`
      : `Internal only: part ${of} of plan ${id}, split by the brief writer; it builds against asm/${id} on our fork and opens no pull request upstream.`,
    ...(prior === undefined ? [] : [`After: ${ref(prior)}`]), ...(section === '' ? [] : ['', section]), ''].join('\n')
  const url = wire.file(homeOf(plan), title, body, labels(plan))
  addPart(db, { parent: plan.id, n, url, title, body, after })
  return url
}

/** Intake re-prices a plan from its issue's P label, so a part filed without one falls to the default. */
function labels(plan: PlanRow): string[] {
  return [...(plan.lane === null ? [] : [`lane:${plan.lane}`]), `P${String(plan.priority)}`]
}

/** A requested change on an assembled pull request, filed and queued as one more internal part on `asm/<parent>`; returns its plan. */
export function fixed(db: Db, root: string, parent: PlanRow, signal: SignalRow, wire: Wire): number {
  const n = partsOf(db, parent.id).length
  const id = String(parent.id)
  const title = `p${id}${letter(n)}: address ${signal.author}'s review on ${signal.repo}#${String(signal.pr)}`
  const body = `${words(signal)}\nInternal only: a fix of plan ${id}; it builds against asm/${id} on our fork and opens no pull request upstream.\n`
  const url = wire.file(homeOf(parent), title, body, labels(parent))
  addPart(db, { parent: parent.id, n, url, title, body, after: null })
  return made(db, root, parent, n, { url, title, body })
}

/** A part whose `After:` issue is closed, however it closed, is queued; `open` is every open issue number of `repo`. */
export function released(db: Db, root: string, repo: string, open: Set<number>): void {
  for (const row of releasable(db, repo).filter((r) => !open.has(r.after))) {
    const id = queue(db, root, planById(db, row.parent), row.n)
    if (id !== null) {
      logged(db, { plan: id, kind: 'unblocked', actor: 'split', outcome: 'pass', message: `#${String(row.after)} closed`, pointer: null, run: null })
    }
  }
}

/** A part's plan is the parent's in every setting but its issue: same pipe, target, lane, seat and priority; an outside parent has no lane or seat, so its part takes the machine lane's. */
function queue(db: Db, root: string, parent: PlanRow, n: number): number | null {
  const row = partAt(db, parent.id, n)
  if (row === undefined) return null
  if (row.plan !== null) return row.plan
  return made(db, root, parent, n, row)
}

function made(db: Db, root: string, parent: PlanRow, n: number, row: { url: string; title: string; body: string }): number {
  const id = queuePart(db, parent, n, row.url, parent.lane ?? 'machine', parent.seat ?? LANE.machine.seat)
  logged(db, { plan: id, kind: 'filed', actor: 'split', outcome: 'pass', message: row.url, pointer: null, run: null })
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
