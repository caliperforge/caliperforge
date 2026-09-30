import { createHash } from 'node:crypto'
import { gates, signedLatest, targetSigned } from '../store/approvals.ts'
import { newest, approved as settle } from '../store/deliverables.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { baseMoved } from './merge.ts'
import { land, type Wire } from './push.ts'
import { following } from './split.ts'

/**
 * Step 7. An external plan reaches here only once `cf approve plan` signed it, so the step passes. An internal plan
 * lands on the gates alone: its deliverable is signed `gates` and its branch goes on `main` in the same step. The
 * base is judged again first, and nothing is signed for a head the rails have not seen.
 */
export function batch(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  if (!internal(plan)) return { outcome: 'pass', spans: [], note: 'batch' }
  const moved = baseMoved(db, root, plan)
  if (moved !== null) return moved
  const head = plan.head_digest
  if (head === null) return { outcome: 'refuse', spans: ['plans'], note: `plan ${String(plan.id)} reached batch with no proved head` }
  const approval = db.transaction(() => {
    const id = gates(db, plan.id, head)
    settle(db, plan.id, id)
    return id
  })()
  const landed = land(db, root, plan, approval, wire)
  if (landed.outcome !== 'pass') return landed
  const next = following(db, root, plan, landedSha(db, plan.id), wire)
  return next === null ? landed : { ...landed, note: `${landed.note}; ${next}` }
}

/** The commit `land` stamped on the deliverable row, which is what closes a split ticket's parent. */
function landedSha(db: Db, plan: number): string {
  return newest(db, plan)?.evidence.split('/').at(-1) ?? ''
}

/** The digest `cf approve target` binds an approval to. */
export function targetDigest(t: { repo: string; issue_no: number; evidence_measured_at: string }): string {
  return createHash('sha256').update(`${t.repo}#${String(t.issue_no)}@${t.evidence_measured_at}`).digest('hex')
}

/**
 * An approval is for one measurement, not for the target forever: the 30-day
 * rule forces a re-measure, and a re-measured target must be approved again.
 */
export function approved(db: Db, plan: PlanRow): boolean {
  const t = db.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(plan.target_id) as
    { repo: string; issue_no: number; evidence_measured_at: string } | undefined
  if (t === undefined || plan.target_id === null) return false
  return targetSigned(db, plan.target_id, targetDigest(t))
}

/**
 * R30 as code's other half: the store refuses the step, this refuses the tick that would have asked for it.
 * The sign-off is for one head on one lap, so it is read off the deliverable row the ready gate wrote and
 * against the head it proved — a rewind opens a new row and clears the head, and the old approval is dead.
 */
export function approvedPlan(db: Db, plan: PlanRow): boolean {
  return signedLatest(db, plan.id, plan.head_digest) !== null
}
