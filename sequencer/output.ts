import type { PlanRow } from '../store/plans.ts'
import { work } from '../templates/research.ts'
import { maybe } from './workspace.ts'

/** A research job's `**Output:**` folder: its fetcher writes there, so its fixer may too. */
export function output(root: string, plan: PlanRow): string | null {
  const named = /^\*\*Output:\*\*(.*)$/m.exec(maybe(root, plan.id, 'ask.md') ?? '')?.[1]?.trim()
  return plan.template === 'research' && named !== undefined ? work(named) : null
}
