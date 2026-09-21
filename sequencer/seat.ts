import type { Fired, Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { reviewManifest, type Bench } from '../runner/packet.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { judge, loadReviews } from '../reviews/bench.ts'
import type { Verdict } from '../reviews/verdict.ts'
import type { Db } from '../store/index.ts'
import { observed } from '../store/lanes.ts'
import { builderRan, internal, type PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import type { Step } from '../templates/pr-path.ts'
import { shape, split, unclear, wide, WIDE, type Part } from './brief.ts'
import { install } from './checks.ts'
import { fenceFor } from './route.ts'
import type { Outcome } from './kind.ts'
import { cloned, diffOf, diffSince, drop, get, maybe, move, planDir, put, snapshot, srcDir } from './workspace.ts'

const INSERT = `INSERT INTO runs
  (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (internal(plan)) install(srcDir(root, plan.id))
  const fired = await ran(db, root, plan, step, provider, rebuild(root, plan), internal(plan))
  put(root, plan.id, `step-${String(step.step)}.handback.md`, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.exit === 0) return { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
  return exited(step, fired)
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
  const missing = shape(fired.text, ask, src)
  if (missing !== null) return { outcome: 'refuse', spans: [missing], note: `${step.runs}: the brief is missing ${missing}` }
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
  return refusal === null ? ask : `${ask}\n\n# Refused — write the whole brief again, fixing this\n\n${refusal}`
}

/** A plan queued before the brief seat carries its ask as `issue.md`, the name the brief now takes. */
function askOf(root: string, plan: number): string {
  return maybe(root, plan, 'ask.md') ?? move(root, plan, 'issue.md', 'ask.md')
}

async function ran(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider,
  issue: string, ours: boolean): Promise<Fired> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs)
  const fired = await provider.fire(
    packet(manifest, prompt, tight(root), issue, srcDir(root, plan.id),
      transcriptOf(root, plan.id, step.step), ours, fenceFor(db, plan.id, manifest.write_paths)))
  const row = db.prepare(INSERT).run(plan.id, step.step, step.runs, hash, provider.name, manifest.model, manifest.effort,
    fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path)
  byRun(db, Number(row.lastInsertRowid), fired.transcript_path)
  observed(db, fired.limits)
  return fired
}

function exited(step: Step, fired: Fired): Outcome {
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} exit ${String(fired.exit)}` }
}

/** The builder's packet, carrying the spans a refusal named so a rebuild is not a repeat. */
function rebuild(root: string, plan: PlanRow): string {
  const issue = get(root, plan.id, 'issue.md')
  const refusal = maybe(root, plan.id, 'refusal.md')
  return refusal === null ? issue : `${issue}\n\n# Refused — rebuild only these spans\n\n${refusal}`
}

export async function fireReview(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  loadReviews(db, root)
  const manifest = reviewManifest(root, step.runs)
  const mine = `step-${String(step.step)}`
  const input: Bench = {
    repo: srcDir(root, plan.id),
    issue: get(root, plan.id, 'issue.md'),
    diff: diffOf(root, plan.id),
    ...(manifest.reads_verdict ? { verdict: priorVerdict(root, plan.id) } : {}),
    ...rounds(root, plan.id, mine),
  }
  try {
    const { outcome } = await judge(db, root, step.runs, plan.id, input, provider, transcriptOf(root, plan.id, step.step))
    put(root, plan.id, `${mine}.verdict.md`, verdictText(outcome))
    keepTree(root, plan.id, mine)
    return { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}`, message: outcome.message }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: 'refuse', spans: ['reviewers.verdict_fence'], note: `${step.runs} ${note}` }
  }
}

/** From a reviewer's second round on: the verdict it wrote last round and what the tree did since. */
function rounds(root: string, plan: number, mine: string): { prior?: string; since?: string } {
  const last = maybe(root, plan, `${mine}.verdict.md`)
  if (last === null) return {}
  const tree = maybe(root, plan, `${mine}.tree`)
  if (tree === null) return { prior: last }
  return { prior: last, since: diffSince(srcDir(root, plan), tree.trim()) }
}

function keepTree(root: string, plan: number, mine: string): void {
  const src = srcDir(root, plan)
  if (cloned(src)) put(root, plan, `${mine}.tree`, `${snapshot(src)}\n`)
}

function transcriptOf(root: string, plan: number, step: number): string {
  return pending(planDir(root, plan), `step-${String(step)}`)
}

/** Step 5 is the second reviewer reading the first one's verdict. */
function priorVerdict(root: string, plan: number): string {
  return maybe(root, plan, 'step-4.verdict.md') ?? 'the first reviewer left no verdict'
}

function verdictText(v: Verdict): string {
  const defect = v.defect_class === null ? '' : `class: ${v.defect_class}\n`
  return `---\noutcome: ${v.outcome}\n${defect}spans:\n${v.spans.map((s) => `  - ${s}`).join('\n')}\n---\n\n${v.message}\n`
}
