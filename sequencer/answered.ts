import { internal, type PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import { unclear } from './brief.ts'
import type { Outcome } from './kind.ts'
import { rerun } from './reproduced.ts'
import { get, maybe, move, put } from './workspace.ts'

/** A question, or an outside `fails` command that exits 0 at base.sha, stops step 1; otherwise the brief to save. */
export function answered(root: string, plan: PlanRow, step: Step, text: string, src: string): Outcome | string {
  const question = unclear(text)
  if (question !== null) return asking(root, plan.id, step, question)
  const run = internal(plan) ? null : rerun(text, src, get(root, plan.id, 'base.sha').trim())
  if (run?.fixed != null) return { outcome: 'needs_coo', spans: ['already fixed'], note: `${step.runs}: ${run.fixed}` }
  return run?.brief ?? text
}

function asking(root: string, plan: number, step: Step, question: string): Outcome {
  if (maybe(root, plan, 'refusal.md') !== null) move(root, plan, 'refusal.md', 'refusal.prev.md')
  put(root, plan, 'question.md', `${question}\n`)
  const base = maybe(root, plan, 'base.sha')
  if (base !== null) put(root, plan, 'question.sha', base)
  return { outcome: 'needs_ceo', spans: [], note: `${step.runs}: ${question}` }
}
