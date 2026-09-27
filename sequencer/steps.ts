import { createHash } from 'node:crypto'
import { CHECK, find } from '../cli/find.ts'
import type { Read } from '../cli/gh.ts'
import { CARD } from '../cli/queue.ts'
import { gates } from '../store/approvals.ts'
import { parse } from '../rails/diff.ts'
import { approved as settle } from '../store/deliverables.ts'
import { building, filesOf, sharing, strays as recordStrays } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { builderRan, internal, originIssue, type PlanRow, type Wait } from '../store/plans.ts'
import { at } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { preReview } from './rails.ts'
import { readyGate, proven, repoOf, target, type Target } from './ready.ts'
import { land, push, reviewable, type Wire } from './push.ts'
import { following } from './split.ts'
import { diffOf, maybe, put } from './workspace.ts'
import { homeOf } from './home.ts'
import { baseMoved, freshBase } from './merge.ts'

/**
 * #140: what the tick says when it passes a plan over, as a reason the store checks rather than a
 * string a caller formats. `WAITING` carries the words; a target that names itself gets them from `parked`.
 */
export function blocked(db: Db, plan: PlanRow): Wait | null {
  const step = at(plan.step)
  if (step.fires === 'ceo') return internal(plan) || approvedPlan(db, plan) ? null : 'ceo_batch'
  if (step.name === 'ruling') return internal(plan) || approved(db, plan) ? null : 'target_approval'
  if (step.name === 'ready') return proven(db, plan) ? null : 'ready_proof'
  if (target(db, plan)?.state === 'parked') return 'target_parked'
  return overlapping(db, plan) === null ? null : 'file_overlap'
}

/**
 * #88. A job about to build waits while another job in the same repo has one of its files in flight.
 * Only a build that has not started waits: a job already building is never stopped by this.
 */
export function overlapping(db: Db, plan: PlanRow): { plan: number; path: string } | null {
  if (at(plan.step).name !== 'build' || builderRan(db, plan.id)) return null
  return sharing(db, plan.id)
}

export const WAITING: Record<Wait, string> = {
  ceo_batch: 'awaiting the sign-off batch',
  target_approval: 'awaiting cf approve target',
  ready_proof: 'awaiting the ready proof',
  target_parked: 'its target is parked',
  token_ceiling: 'it spent the token ceiling since a person last sent it round',
  leased: 'another live tick holds it',
  over_cap: 'its lane is open and full',
  lane_over_cap: 'the lane cap was spent on a lower lane',
  no_step_map: 'its template has no step map',
  file_overlap: 'another job is building one of its files',
}

/** The parked target by name, which the bare reason cannot carry. */
export function parked(db: Db, plan: PlanRow): string | null {
  const row = target(db, plan)
  return row?.state === 'parked' ? `${row.repo}#${String(row.issue_no)} is parked` : null
}

export function kernel(db: Db, root: string, plan: PlanRow, wire?: Wire, read?: Read): Outcome {
  const step = at(plan.step)
  if (step.name === 'rails') return freshBase(db, root, plan) ?? strayed(db, root, plan) ?? railed(db, root, plan, wire)
  if (step.name === 'measure') return measure(db, root, plan, read)
  if (step.name === 'ready') return readyGate(db, root, plan, wire)
  if (step.name === 'batch') return batch(db, root, plan, wire)
  if (step.name === 'push') return push(db, root, plan, wire)
  return { outcome: 'pass', spans: [], note: step.name }
}

function railed(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const judged = preReview(db, root, plan, wire)
  const repo = repoOf(db, plan)
  if (judged.outcome === 'pass' && judged.held !== true && repo !== null) reviewable(root, plan, repo, wire)
  return judged
}

/**
 * Step 7. An external plan only reaches here once `cf approve plan` wrote the CEO's row, so the
 * step has nothing left to do and says so. An internal plan lands on the gates alone (#20): the
 * four gate verdicts and the ready rail are the whole sign-off, the row that settles its
 * deliverable is signed `gates`, and the same step puts the branch on `main` (#35 rule 1). The
 * store's step-7 trigger reads that signature only on a plan that names an origin, so an external
 * plan still cannot leave ready on anything but the CEO's. The base is judged again before any of
 * that: a `main` that moved since ready is #35 rule 3's case, and nothing is signed for a head the
 * rails have not seen.
 */
function batch(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
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
  const row = db.prepare('SELECT evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(plan) as
    { evidence: string } | undefined
  return row?.evidence.split('/').at(-1) ?? ''
}

/**
 * #89. #88 holds jobs apart on the paths their briefs named, and a build that wrote outside that list
 * breaks the promise silently. So every path the build wrote outside it is recorded as a stray -- which #88
 * reads on the next pick, and the rails do not -- and one an older job is building holds
 * this job here, that job named, until it settles. A path nobody else holds goes on to the rails as before.
 */
function strayed(db: Db, root: string, plan: PlanRow): Outcome | null {
  const listed = filesOf(db, plan.id).map((f) => f.path)
  if (listed.length === 0) return null
  const wrote = parse(diffOf(root, plan.id)).map((f) => f.path)
  recordStrays(db, plan.id, wrote.filter((path) => !listed.includes(path)))
  const other = building(db, plan.id, wrote)
  if (other === null) return null
  return { outcome: 'pass', held: true, spans: [other.path], note: `wrote ${other.path}, which plan ${String(other.plan)} is building; waits for it` }
}

export function measure(db: Db, root: string, plan: PlanRow, read?: Read): Outcome {
  if (internal(plan)) return { outcome: 'pass', spans: [], note: `${homeOf(plan)}#${String(originIssue(plan))} is ours; no account to measure` }
  const row = target(db, plan)
  if (row === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const span = `targets/${row.repo}#${String(row.issue_no)}`
  if (row.state !== 'ready' && row.state !== 'queued') return { outcome: 'refuse', spans: [span], note: `target state ${row.state}` }
  const park = read === undefined ? null : checked(root, plan, row, read)
  if (park === null) return { outcome: 'pass', spans: [], note: `${row.repo}#${String(row.issue_no)} ${row.pulse}` }
  db.prepare("UPDATE targets SET state = 'parked' WHERE id = ?").run(plan.target_id)
  return { outcome: 'refuse', held: true, spans: [span], note: park }
}

function checked(root: string, plan: PlanRow, row: Target, read: Read): string | null {
  const ask = maybe(root, plan.id, 'ask.md') ?? ''
  const found = find(row.repo, row.issue_no, ask.includes(CARD), read)
  const at = ask.lastIndexOf(`\n${CHECK}\n`)
  put(root, plan.id, 'ask.md', `${at === -1 ? ask : ask.slice(0, at)}\n${found.section}`)
  return found.park
}

/** The repository and issue a plan's checkout is made from, if it has one. */
export function targetOf(db: Db, plan: PlanRow): { repo: string; issue_no: number; part: string } | null {
  const row = db.prepare('SELECT repo, issue_no, part FROM targets WHERE id = ?').get(plan.target_id)
  return (row ?? null) as { repo: string; issue_no: number; part: string } | null
}

/** The digest `cf approve target` binds an approval to. */
export function targetDigest(t: { repo: string; issue_no: number; evidence_measured_at: string }): string {
  return createHash('sha256').update(`${t.repo}#${String(t.issue_no)}@${t.evidence_measured_at}`).digest('hex')
}

/**
 * An approval is for one measurement, not for the target forever: the 30-day
 * rule forces a re-measure, and a re-measured target must be approved again.
 */
function approved(db: Db, plan: PlanRow): boolean {
  const t = db.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(plan.target_id) as
    { repo: string; issue_no: number; evidence_measured_at: string } | undefined
  if (t === undefined) return false
  return db.prepare("SELECT 1 FROM approvals WHERE subject_kind = 'target' AND subject_id = ? AND subject_digest = ? AND decision = 'approved'")
    .get(plan.target_id, targetDigest(t)) !== undefined
}

/**
 * R30 as code's other half: the store refuses the step, this refuses the tick that would have asked for it.
 * The sign-off is for one head on one lap, so it is read off the deliverable row the ready gate wrote and
 * against the head it proved — a rewind opens a new row and clears the head, and the old approval is dead.
 */
function approvedPlan(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables d JOIN approvals a ON a.id = d.approval_id
    WHERE d.plan_id = ? AND d.state = 'approved'
      AND d.id = (SELECT max(id) FROM deliverables WHERE plan_id = d.plan_id)
      AND a.subject_kind = 'plan' AND a.subject_id = d.plan_id
      AND a.decision = 'approved' AND a.subject_digest = ?`).get(plan.id, plan.head_digest) !== undefined
}
