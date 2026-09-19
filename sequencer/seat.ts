import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { reviewManifest, type Bench } from '../runner/packet.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { judge, loadReviews } from '../reviews/bench.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { diffOf, get, maybe, planDir, put, srcDir } from './workspace.ts'

const INSERT = `INSERT INTO runs
  (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs)
  const fired = await provider.fire(
    packet(manifest, prompt, tight(root), brief(root, plan), srcDir(root, plan.id),
      transcriptOf(root, plan.id, step.step), internal(plan)))
  const row = db.prepare(INSERT).run(plan.id, step.step, step.runs, hash, provider.name, manifest.model, manifest.effort,
    fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path)
  byRun(db, Number(row.lastInsertRowid), fired.transcript_path)
  put(root, plan.id, `step-${String(step.step)}.handback.md`, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.exit === 0) return { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} exit ${String(fired.exit)}` }
}

/** The builder's packet, carrying the spans a refusal named so a rebuild is not a repeat. */
function brief(root: string, plan: PlanRow): string {
  const issue = get(root, plan.id, 'issue.md')
  const refusal = maybe(root, plan.id, 'refusal.md')
  return refusal === null ? issue : `${issue}\n\n# Refused — rebuild only these spans\n\n${refusal}`
}

export async function fireReview(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  loadReviews(db, root)
  const manifest = reviewManifest(root, step.runs)
  const input: Bench = {
    repo: srcDir(root, plan.id),
    issue: get(root, plan.id, 'issue.md'),
    diff: diffOf(root, plan.id),
    ...(manifest.reads_verdict ? { verdict: priorVerdict(root, plan.id) } : {}),
  }
  try {
    const { outcome } = await judge(db, root, step.runs, plan.id, input, provider, transcriptOf(root, plan.id, step.step))
    put(root, plan.id, `step-${String(step.step)}.verdict.md`, verdictText(outcome))
    return { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}` }
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { outcome: 'refuse', spans: ['reviewers.verdict_fence'], note: `${step.runs} ${note}` }
  }
}

function transcriptOf(root: string, plan: number, step: number): string {
  return pending(planDir(root, plan), `step-${String(step)}`)
}

/** Step 5 is the second reviewer reading the first one's verdict. */
function priorVerdict(root: string, plan: number): string {
  return maybe(root, plan, 'step-4.verdict.md') ?? 'the first reviewer left no verdict'
}

function verdictText(v: { outcome: string; spans: string[]; message: string }): string {
  return `---\noutcome: ${v.outcome}\nspans:\n${v.spans.map((s) => `  - ${s}`).join('\n')}\n---\n\n${v.message}\n`
}
