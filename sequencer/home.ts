import type { Db } from '../store/index.ts'
import { internal, originRef, type PlanRow } from '../store/plans.ts'
import { FORK, repoName, SELF } from './workspace.ts'

/**
 * #69. The repo a plan of ours builds and lands in: the one its issue was filed on. A lane's home is
 * `cli/plan.ts` `LANE`; the kernel's own repo is `SELF`.
 */
export function homeOf(plan: PlanRow): string {
  return originRef(plan)?.repo ?? SELF
}

/** A plan on the kernel's own repo: the one tree with our npm scripts, roster digests and schema files. */
export function kernelPlan(plan: PlanRow): boolean {
  return internal(plan) && plan.target_id === null && homeOf(plan) === SELF
}

/** The branch on our fork a part of an outside plan is cut from and lands on, or null for any other plan. */
export function assembly(db: Db, plan: PlanRow): { branch: string; fork: string } | null {
  const row = db.prepare('SELECT p.parent, t.repo FROM parts p JOIN targets t ON t.id = ? WHERE p.plan = ?')
    .get(plan.target_id, plan.id) as { parent: number; repo: string } | undefined
  return row === undefined ? null : { branch: `asm/${String(row.parent)}`, fork: `${FORK}/${repoName(row.repo)}` }
}
