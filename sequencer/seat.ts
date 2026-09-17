import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { get, planDir, put } from './workspace.ts'

const INSERT = `INSERT INTO runs
  (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

type Judge = (db: Db, root: string, name: string, plan: number, input: unknown, provider: Provider)
  => Promise<{ outcome: { outcome: 'pass' | 'refuse' | 'needs_ceo'; spans: string[] } }>

const Bench = z.object({ judge: z.custom<Judge>((v) => typeof v === 'function') })

export async function fireSeat(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, step.runs)
  const issue = get(root, plan.id, 'issue.md')
  const fired = await provider.fire(packet(manifest, prompt, tight(root), issue, planDir(root, plan.id)))
  db.prepare(INSERT).run(plan.id, step.step, step.runs, hash, provider.name, manifest.model, manifest.effort,
    fired.usage.input, fired.usage.cache, fired.usage.output, fired.seconds, fired.exit)
  put(root, plan.id, `step-${String(step.step)}.handback.md`, fired.text)
  const tokens = fired.usage.input + fired.usage.cache + fired.usage.output
  if (fired.exit === 0) return { outcome: 'pass', spans: [], note: `${step.runs} exit 0, ${String(tokens)} tokens` }
  return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} exit ${String(fired.exit)}` }
}

export async function fireReview(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const bench = join(root, 'reviews/bench.ts')
  if (!existsSync(join(root, 'reviews', step.runs, 'manifest.yaml')) || !existsSync(bench)) {
    return { outcome: 'needs_ceo', spans: [`reviews/${step.runs}`], note: `reviews/${step.runs} is not in the tree` }
  }
  const { judge } = Bench.parse(await import(pathToFileURL(bench).href))
  const subject = get(root, plan.id, 'step-2.handback.md')
  const { outcome } = await judge(db, root, step.runs, plan.id, subject, provider)
  return { outcome: outcome.outcome, spans: outcome.spans, note: `${step.runs} ${outcome.outcome}` }
}
