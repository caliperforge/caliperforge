import type { PlanRow } from '../store/plans.ts'
import { builder, type Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'

export function seatless(plan: PlanRow, step: Step, language: string | null): Outcome | null {
  if (plan.template !== 'pr_path' || step.fires !== 'seat' || builder(language) !== null) return null
  return { outcome: 'needs_ceo', spans: ['staffing'], note: `no ${String(language)} ${String(step.mode)} seat` }
}
