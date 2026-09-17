import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { reviewManifest, type Bench } from '../runner/packet.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { judge, loadReviews } from '../reviews/bench.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { cloned, get, gitDiff, maybe, planDir, put, srcDir } from './workspace.ts'

const INSERT = `INSERT INTO runs
  (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs)
  const fired = await provider.fire(
    packet(manifest, prompt, tight(root), brief(root, plan), srcDir(root, plan.id), transcriptOf(root, plan.id, step.step)))
  db.prepare(INSERT).run(plan.id, step.step, step.runs, hash, provider.name, manifest.model, manifest.effort,
    fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit, fired.transcript_path)
  put(root, plan.id, `step-${String(step.step)}.handback.md`, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.exit === 0) return { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} exit ${String(fired.exit)}` }
}

/**
 * The builder's packet. A rebuild is not a repeat: if a rail or a reviewer
 * refused, `settle()` has written the spans to `step-<n>.refusal.md` and they
 * ride along, so the seat is told what to fix instead of guessing.
 */
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
  const { outcome } = await judge(db, root, step.runs, plan.id, input, provider, transcriptOf(root, plan.id, step.step))
  put(root, plan.id, `step-${String(step.step)}.verdict.md`, verdictText(outcome))
  return { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}` }
}

function transcriptOf(root: string, plan: number, step: number): string {
  return join(planDir(root, plan), `step-${String(step)}.transcript.jsonl`)
}

/** Step 5 is the second reviewer reading the first one's verdict. */
function priorVerdict(root: string, plan: number): string {
  return maybe(root, plan, 'step-4.verdict.md') ?? 'the first reviewer left no verdict'
}

function verdictText(v: { outcome: string; spans: string[]; message: string }): string {
  return `---\noutcome: ${v.outcome}\nspans:\n${v.spans.map((s) => `  - ${s}`).join('\n')}\n---\n\n${v.message}\n`
}

/**
 * What step 2 changed, as a unified diff the reviewer and `rails/diff.ts` can
 * both read. In a real checkout that is `git diff` against the sha the branch
 * was cut from, so an untouched workspace diffs to nothing; without one the
 * workspace starts empty and every file in it is an addition.
 */
function diffOf(root: string, plan: number): string {
  const src = srcDir(root, plan)
  const base = maybe(root, plan, 'base.sha')
  if (base !== null && cloned(src)) return gitDiff(src, base.trim())
  return additions(src)
}

function additions(src: string): string {
  return files(src).map((path) => {
    const body = readFileSync(path, 'utf8')
    const lines = body.split('\n')
    const rel = relative(src, path)
    return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}`
  }).join('\n')
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
}
