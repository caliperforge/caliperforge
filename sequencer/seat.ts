import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Fired, Provider } from '../providers/kind.ts'
import { packet, refuse } from '../runner/index.ts'
import { reviewManifest, type Bench, type Narrowing } from '../runner/packet.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { judge, loadReviews } from '../reviews/bench.ts'
import type { Finding, Judged } from '../reviews/verdict.ts'
import type { Db } from '../store/index.ts'
import { filesOf } from '../store/files.ts'
import { observed, wall } from '../store/lanes.ts'
import { builderRan, internal, type PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import type { Step } from '../templates/pr-path.ts'
import { parse } from '../rails/diff.ts'
import { pointed, shape, split, TEMPLATE, unclear, wide, WIDE, type Part } from './brief.ts'
import { handout, touched, type Handed } from './handout.ts'
import { handover, type Handover } from './handover.ts'
import { install, mode } from './checks.ts'
import { narrow } from './rails.ts'
import { deletions } from './fence.ts'
import { fenceFor } from './route.ts'
import type { Outcome } from './kind.ts'
import { carried, cloned, diffOf, diffSince, drop, get, maybe, move, narrowing, planDir, put, snapshot, srcDir } from './workspace.ts'
import { kernelPlan } from './home.ts'

const INSERT = `INSERT INTO runs
  (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (kernelPlan(plan)) install(srcDir(root, plan.id))
  const name = `step-${String(step.step)}.handback.md`
  const prev = maybe(root, plan.id, name)
  if (prev !== null) put(root, plan.id, `step-${String(step.step)}.handback.prev.md`, prev)
  const fired = await ran(db, root, plan, step, provider, rebuild(db, root, plan, prev), kernelPlan(plan))
  put(root, plan.id, name, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.exit !== 0) return exited(step, fired)
  return dropped(db, root, plan, step, fired.text)
    ?? { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
}

/**
 * #64. The build names paths under `## Deleted` and the kernel removes them, before the rails read the
 * tree; `git add -A` at the commit stages the removal, so the deletion is in the diff the reviewers
 * judge. The fence that bars a write bars a delete -- the same `refuse()` the seat's own tools run
 * through -- and a path that is not there refuses rather than passing as a silent no-op.
 */
function dropped(db: Db, root: string, plan: PlanRow, step: Step, handback: string): Outcome | null {
  const paths = deletions(handback)
  if (paths.length === 0) return null
  const src = srcDir(root, plan.id)
  const fence = fenceFor(db, plan.id, seat(root, step.runs).manifest.write_paths)
  const barred = paths.filter((path) => refuse(src, fence, path, kernelPlan(plan)) !== null)
  const absent = paths.filter((path) => !barred.includes(path) && !existsSync(join(src, path)))
  if (barred.length > 0 || absent.length > 0) {
    const why = [...barred.map((p) => `${p} is outside the fence`), ...absent.map((p) => `${p} is not in the tree`)]
    return { outcome: 'refuse', spans: [...barred, ...absent], note: `${step.runs}: ${why.join('; ')}` }
  }
  for (const path of paths) rmSync(join(src, path))
  return null
}

/**
 * Step 1. The seat's reply is the brief, and the machine is what saves it: everything downstream reads
 * `issue.md` and so works from the brief, never from the ask. A plan a builder has already run on keeps
 * the ticket it was built against, whatever its shape, and a brief that still passes stands, so the
 * contract the reviewers read does not move under them between rebuild rounds.
 */
export async function fireBrief(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (builderRan(db, plan.id)) return stands()
  const saved = split(maybe(root, plan.id, 'split.md') ?? '')
  if (saved !== null) return splitting(step, saved)
  const ask = askOf(root, plan.id)
  const src = srcDir(root, plan.id)
  const standing = maybe(root, plan.id, 'issue.md')
  if (standing !== null && shape(standing, ask, src) === null) return stands()
  const fired = await ran(db, root, plan, step, provider, again(root, plan.id, ask), false)
  if (fired.exit !== 0) return exited(step, fired)
  const question = unclear(fired.text)
  if (question !== null) {
    put(root, plan.id, 'question.md', `${question}\n`)
    return { outcome: 'needs_ceo', spans: [], note: `${step.runs}: ${question}` }
  }
  const parts = split(fired.text)
  if (parts !== null) {
    put(root, plan.id, 'split.md', fired.text)
    return splitting(step, parts)
  }
  const refused = shape(fired.text, ask, src)
  if (refused !== null) return { outcome: 'refuse', spans: [refused.span], note: `${step.runs}: ${refused.reason}` }
  const width = internal(plan) ? wide(fired.text) : null
  if (width !== null) {
    return { outcome: 'refuse', spans: ['brief.wide'],
      note: `${step.runs}: the brief touches ${String(width)} files besides tests; past ${String(WIDE)} it is more than one job, so answer with the split fence` }
  }
  put(root, plan.id, 'issue.md', fired.text)
  drop(root, plan.id, 'refusal.md')
  return { outcome: 'pass', spans: [], note: `${step.runs}: brief written` }
}

/** The answer is kept until it is filed, so a `gh` that fails half way does not buy a second brief. */
function splitting(step: Step, parts: Part[]): Outcome {
  return { outcome: 'pass', spans: [], note: `${step.runs}: ${String(parts.length)} jobs, not one`, parts }
}

function stands(): Outcome {
  return { outcome: 'pass', spans: [], note: 'the brief stands' }
}

function again(root: string, plan: number, ask: string): string {
  const refusal = maybe(root, plan, 'refusal.md')
  const asked = `${ask}\n\n${TEMPLATE}`
  return refusal === null ? asked : `${asked}\n# Refused — write the whole brief again, fixing this\n\n${refusal}`
}

/** A plan queued before the brief seat carries its ask as `issue.md`, the name the brief now takes. */
function askOf(root: string, plan: number): string {
  return maybe(root, plan, 'ask.md') ?? move(root, plan, 'issue.md', 'ask.md')
}

export async function ran(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider,
  issue: string, ours: boolean): Promise<Fired> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs)
  const fired = await provider.fire({
    ...packet(manifest, prompt, tight(root), issue, srcDir(root, plan.id),
      transcriptOf(root, plan.id, step.step), ours, fenceFor(db, plan.id, manifest.write_paths)),
    wall: wall(db),
  })
  const row = db.prepare(INSERT).run(plan.id, step.step, step.runs, hash, provider.name, manifest.model, manifest.effort,
    fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path)
  byRun(db, Number(row.lastInsertRowid), fired.transcript_path)
  observed(db, fired.limits)
  return fired
}

function exited(step: Step, fired: Fired): Outcome {
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} exit ${String(fired.exit)}` }
}

/**
 * The builder's packet (#67): the brief and the text of the files it lists; on a rebuild, the spans the
 * refusal named, the rows its last hand-back claimed, the builder's own diff so far, and the text of only
 * the files those touch. After a #162 re-cut the diff is the one carried across and the files are main's,
 * so the packet says to re-apply rather than to carry on: the builder is looking at a tree that has none
 * of its work in it.
 */
function rebuild(db: Db, root: string, plan: PlanRow, prev: string | null): string {
  const src = srcDir(root, plan.id)
  const issue = get(root, plan.id, 'issue.md')
  const refusal = maybe(root, plan.id, 'refusal.md')
  const rows = lastRows(prev)
  if (refusal === null) return handed(`${issue}${rows}`, handout(src, listed(db, plan.id, issue)))
  const diff = diffOf(root, plan.id)
  if (stopped(refusal) && carried(root, plan.id) === null) return resumed(db, src, plan.id, `${issue}${rows}`, diff)
  const again = `${issue}\n\n# Refused — rebuild only these spans\n\n${refusal}${rows}`
  const since = diff.trim() === '' ? again : `${again}\n\n# ${headed(root, plan.id)}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``
  return handed(since, handout(src, touched(diff, refusal)))
}

/** A build the wall or an exit cut short was never judged: the refusal names the stop, not a fault in the work. */
export function stopped(refusal: string): boolean {
  return /^step \d+ build refused by \S+\n\n\S+ exit [1-9]\d*\n/.test(refusal)
}

/**
 * The work a stopped fire left in the tree is kept, and the next fire is told so: it is handed what it
 * has not written yet, not the files it already changed, so it finishes instead of starting over.
 */
function resumed(db: Db, src: string, plan: number, issue: string, diff: string): string {
  const listing = listed(db, plan, issue)
  if (diff.trim() === '') return handed(issue, handout(src, listing))
  const done = new Set(parse(diff).map((f) => f.path))
  const left = filesOf(db, plan).map((f) => f.path).filter((p) => !done.has(p))
  const rest = left.length === 0 ? '' : ` Not written yet: ${left.map((p) => `\`${p}\``).join(', ')}.`
  const head = '# Your last fire stopped before it finished\n\nThe diff below is your work so far and the checkout holds it. '
    + `Keep it: do not re-read or rewrite what it holds. Finish what is left.${rest} Answer every D row the diff does not answer yet.`
  return handed(`${issue}\n\n${head}\n\n\`\`\`\`diff\n${diff}\n\`\`\`\``, handout(src, listing.filter((f) => !done.has(f.path))))
}

/** The rows the last fence claimed: a rebuild's own fence answers every case, not only the ones it touched. */
function lastRows(prev: string | null): string {
  const done = /^---\r?\n[\s\S]*?^(done:[\s\S]*?)\r?\n---\s*$/m.exec(prev ?? '')?.[1]
  return done === undefined ? '' : `\n\n# Your last hand-back — carry these rows forward, updating the ones you rebuild\n\n${done}\n`
}

function headed(root: string, plan: number): string {
  return carried(root, plan) === null
    ? 'Your diff so far'
    : 'Main moved and your work conflicted with it, so the checkout was cut again from main — '
      + 'the files below are main\'s and hold none of your work. Re-apply this diff onto them'
}

/** The brief's files from the store, a new one left out, each with the lines the brief points it at. */
function listed(db: Db, plan: number, issue: string): Handed[] {
  const lines = pointed(issue)
  return filesOf(db, plan).filter((f) => !f.is_new).flatMap((f): Handed[] => {
    const at = lines.filter((l) => l.path === f.path)
    return at.length === 0 ? [{ path: f.path, line: null }] : at
  })
}

function handed(issue: string, files: string): string {
  return files === '' ? issue : `${issue}\n\n${files}`
}

/** The verdict, the findings behind its spans, and the tree it was written against. */
export interface Round {
  outcome: Outcome
  findings: Finding[]
  tree: string | null
}

export async function fireReview(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Round> {
  loadReviews(db, root)
  const manifest = reviewManifest(root, step.runs)
  const src = srcDir(root, plan.id)
  const input: Bench = {
    repo: src,
    issue: get(root, plan.id, 'issue.md'),
    diff: diffOf(root, plan.id),
    ...(cloned(src) ? { tree: snapshot(src) } : {}),
    ...outside(root, plan, src),
    ...checked(db, plan, src, diffOf(root, plan.id)),
    ...(manifest.reads_verdict ? { verdict: priorVerdict(root, plan.id) } : {}),
    ...rounds(db, root, plan.id, step.step),
  }
  try {
    const { outcome } = await judge(db, root, step.runs, plan.id, input, provider, transcriptOf(root, plan.id, step.step))
    put(root, plan.id, `step-${String(step.step)}.verdict.md`, verdictText(outcome))
    return {
      outcome: { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}`, message: outcome.message },
      findings: outcome.findings,
      tree: input.tree ?? null,
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: { outcome: 'refuse', spans: ['reviewers.verdict_fence'], note: `${step.runs} ${note}` }, findings: [], tree: null }
  }
}

/** #132: on someone else's repository the reviewer is handed its footing instead of reading for it. */
function outside(root: string, plan: PlanRow, src: string): Handover {
  const base = maybe(root, plan.id, 'base.sha')
  return internal(plan) || base === null || !cloned(src) ? {} : handover(src, base.trim())
}

/**
 * #86. Step 3 already ran the checkout's own checks on this diff; the reviewer is told so rather than
 * reasoning its way to it. Read off the rail's row, never re-run, and only while the diff is the one it judged.
 */
function checked(db: Db, plan: PlanRow, src: string, diff: string): { checks?: string } {
  if (!internal(plan)) return {}
  const row = db.prepare(`SELECT outcome, subject_digest FROM verdicts WHERE plan = ? AND kind = 'rail' AND rail_id = 'checks'
    ORDER BY id DESC LIMIT 1`).get(plan.id) as { outcome: string; subject_digest: string } | undefined
  if (row?.outcome !== 'pass' || row.subject_digest !== createHash('sha256').update(diff).digest('hex')) return {}
  const scope = narrow(db, plan).length > 0 ? 'the tests this plan\'s files reach' : 'the whole suite'
  return { checks: `Passed on this diff: every script the checkout names exits zero (${mode(src)}, ${scope}). Do not re-derive what they settle.` }
}

/** From a reviewer's second round on: the verdict it wrote last round, and what the tree did since the one it judged. */
function rounds(db: Db, root: string, plan: number, step: number): { prior?: string; since?: string; narrowing?: Narrowing } {
  const last = maybe(root, plan, `step-${String(step)}.verdict.md`)
  if (last === null) return {}
  const tree = judged(db, plan, step)
  if (tree === null) return { prior: last }
  const src = srcDir(root, plan)
  return { prior: last, since: diffSince(src, tree), narrowing: narrowing(src, tree, get(root, plan, 'base.sha').trim()) }
}

/** The tree the reviewer's own last verdict judged, off the row `judge()` wrote it on. */
function judged(db: Db, plan: number, step: number): string | null {
  const row = db.prepare("SELECT tree FROM verdicts WHERE plan = ? AND step = ? AND kind = 'review' ORDER BY id DESC LIMIT 1")
    .get(plan, step) as { tree: string | null } | undefined
  return row?.tree ?? null
}

function transcriptOf(root: string, plan: number, step: number): string {
  return pending(planDir(root, plan), `step-${String(step)}`)
}

/** Step 5 is the second reviewer reading the first one's verdict. */
function priorVerdict(root: string, plan: number): string {
  return maybe(root, plan, 'step-4.verdict.md') ?? 'the first reviewer left no verdict'
}

function verdictText(v: Judged): string {
  const defect = v.defect_class === null ? '' : `class: ${v.defect_class}\n`
  return `---\noutcome: ${v.outcome}\n${defect}spans:\n${v.findings.map(entry).join('\n')}\n---\n\n${v.message}\n`
}

/** A plain finding is the bare span the reviewers have always written; a cosmetic one carries its fix on. */
function entry(f: Finding): string {
  if (f.kind === 'real' && f.fix === null) return `  - ${f.span}`
  return `  - span: ${f.span}\n    kind: ${f.kind}\n    fix: ${JSON.stringify(f.fix)}`
}
