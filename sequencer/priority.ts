import { gh, run, type Read, type Run } from '../cli/gh.ts'
import { issue, priorityOf } from '../cli/plan.ts'
import type { Db } from '../store/index.ts'
import { priority, ranked, templatePriority } from '../store/lanes.ts'
import { allPlans, originRef, planById, type PlanRow } from '../store/plans.ts'

export function relabel(db: Db, id: number, n: number, hand: { actor: string; why: string }, read: Read = gh, exec: Run = run): void {
  const ref = originRef(planById(db, id))
  ranked(n)
  if (ref !== null) {
    const label = `P${String(n)}`
    const others = issue(ref.repo, ref.no, read).labels.filter((l) => priorityOf([l]) !== null && l.name !== label)
    exec(['issue', 'edit', String(ref.no), '--repo', ref.repo, '--add-label', label, ...others.flatMap((l) => ['--remove-label', l.name])])
  }
  priority(db, id, n, hand)
}

/**
 * The `P<n>` label on the issue is the plan's priority, re-read every tick: relabel the ticket and
 * the queue reorders. A tick handed no reader calls no `gh` and re-prices nothing.
 */
export function reprice(db: Db, read: Read | undefined): void {
  if (read === undefined) return
  for (const plan of internal(db)) {
    const n = priced(db, plan, read)
    if (n !== null) priority(db, plan.id, n)
  }
}

/** An issue `gh` cannot read this tick, or one carrying two `P` labels, leaves the plan on the priority it has. */
function priced(db: Db, plan: PlanRow, read: Read): number | null {
  const ref = originRef(plan)
  if (ref === null) return null
  try {
    return priorityOf(issue(ref.repo, ref.no, read).labels) ?? templatePriority(db, plan.template)
  } catch {
    return null
  }
}

function internal(db: Db): PlanRow[] {
  return allPlans(db).filter((p) => p.origin !== null && (p.state === 'queued' || p.state === 'running'))
}
