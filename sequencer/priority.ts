import type { Read } from '../cli/gh.ts'
import { issue, priorityOf } from '../cli/plan.ts'
import type { Db } from '../store/index.ts'
import { priority, templatePriority } from '../store/lanes.ts'
import { originRef, PlanRow } from '../store/plans.ts'

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
  return db.prepare("SELECT * FROM plans WHERE origin IS NOT NULL AND state IN ('queued', 'running')")
    .all().map((r) => PlanRow.parse(r))
}
