import type { Db } from '../store/index.ts'
import { partOf, partsOf } from '../store/parts.ts'
import { internal, originRef, type PlanRow } from '../store/plans.ts'
import { targetRef } from '../store/targets.ts'
import { FORK, maybe, repoName, SELF } from './workspace.ts'

/**
 * The repo a plan of ours builds and lands in: the one its issue was filed on. A lane's home is
 * `store/lanes.ts` `LANE`; the kernel's own repo is `SELF`.
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
  const part = partOf(db, plan.id)
  const target = targetRef(db, plan.target_id)
  return part === undefined || target === null ? null : { branch: `asm/${String(part.parent)}`, fork: `${FORK}/${repoName(target.repo)}` }
}

/** The branch an internal plan is cut from and lands on: a part's `asm/<parent>`, else the one its ask's `Base:` line names, else `main`. */
export function onto(db: Db, root: string, plan: PlanRow): string {
  return assembly(db, plan)?.branch ?? /^Base: ([\w./-]+)$/m.exec(maybe(root, plan.id, 'ask.md') ?? '')?.[1] ?? 'main'
}

/** The branch an outside plan split into parts is checked, reviewed and sent upstream from, or null for any other plan. */
export function assembling(db: Db, plan: PlanRow): string | null {
  if (internal(plan)) return null
  return partsOf(db, plan.id).length === 0 ? null : `asm/${String(plan.id)}`
}
