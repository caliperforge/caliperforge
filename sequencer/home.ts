import { internal, originRef, type PlanRow } from '../store/plans.ts'
import { SELF } from './workspace.ts'

/**
 * #69. The repo a plan of ours builds and lands in: the one its issue was filed on. A lane's home is
 * `cli/plan.ts` `LANE`; the kernel's own repo is `SELF`.
 */
export function homeOf(plan: PlanRow): string {
  return originRef(plan)?.repo ?? SELF
}

/** A plan on the kernel's own repo: the one tree with our npm scripts, roster digests and schema files. */
export function kernelPlan(plan: PlanRow): boolean {
  return internal(plan) && homeOf(plan) === SELF
}
