import { CHECK, find } from '../cli/find.ts'
import type { Read } from '../cli/gh.ts'
import { CARD, waits } from '../cli/queue.ts'
import { parse } from '../rails/diff.ts'
import { building, filesOf, recorded, sharing, strays as recordStrays } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { builderRan, held, internal, originIssue, originRef, waiting, type PlanRow, type Wait } from '../store/plans.ts'
import { capture, desk, facts, gather, pack, score, steps as comms } from '../templates/comms.ts'
import { at, last, steps, type Step } from '../templates/pr-path.ts'
import { approved, approvedPlan, batch } from './approve.ts'
import type { Outcome } from './kind.ts'
import { publish } from './publish.ts'
import { preReview } from './rails.ts'
import { readyGate, proven, repoOf, target, type Target } from './ready.ts'
import { push, reviewable, type Wire } from './push.ts'
import { diffOf, maybe, put } from './workspace.ts'
import { homeOf } from './home.ts'
import { freshBase } from './merge.ts'
import { hold } from './hold.ts'

interface StepMap {
  steps: Step[]
  at(step: number, language?: string | null): Step
  last(step: number): boolean
}

function listed(name: string, list: Step[]): StepMap {
  return {
    steps: list,
    at: (step) => {
      const found = list.find((s) => s.step === step)
      if (found === undefined) throw new Error(`${name} has no step ${String(step)}`)
      return found
    },
    last: (step) => step === list.at(-1)?.step,
  }
}

const MAPS: Record<PlanRow['template'], StepMap> = {
  pr_path: { steps, at, last },
  /** templates/comms.ts imports back into this module through sequencer/seat.ts, so its steps may not exist yet when this one loads. */
  get comms() { return listed('comms', comms) },
  research: listed('research', []),
}

export function mapOf(template: PlanRow['template']): StepMap {
  return MAPS[template]
}

/**
 * What the tick says when it passes a plan over, as a reason the store checks rather than a
 * string a caller formats. `WAITING` carries the words; a target that names itself gets them from `parked`.
 */
export function blocked(db: Db, plan: PlanRow): Wait | null {
  const step = mapOf(plan.template).at(plan.step)
  if (step.fires === 'ceo') return internal(plan) || approvedPlan(db, plan) ? null : 'ceo_batch'
  if (step.name === 'ruling') return internal(plan) || approved(db, plan) ? null : 'target_approval'
  if (step.name === 'ready') return proven(db, plan) ? null : 'ready_proof'
  if (target(db, plan)?.state === 'parked') return 'target_parked'
  return overlapping(db, plan) === null ? null : 'file_overlap'
}

/**
 * A job about to build waits while another job in the same repo has one of its files in flight.
 * Only a build that has not started waits: a job already building is never stopped by this.
 */
export function overlapping(db: Db, plan: PlanRow): { plan: number; path: string } | null {
  if (mapOf(plan.template).at(plan.step).name !== 'build' || builderRan(db, plan.id)) return null
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
  const step = mapOf(plan.template).at(plan.step)
  if (step.name === 'rails') return freshBase(db, root, plan) ?? strayed(db, root, plan) ?? railed(db, root, plan, wire)
  if (step.name === 'measure') return measure(db, root, plan, read)
  if (step.name === 'ready') return readyGate(db, root, plan, wire)
  if (step.name === 'batch') return batch(db, root, plan, wire)
  if (step.name === 'push') return push(db, root, plan, wire)
  if (step.name === 'gather') return gather(db, root, plan)
  if (step.name === 'facts') return facts(root, plan)
  if (step.name === 'desk') return desk(db, root, plan)
  if (step.name === 'capture') return capture(db, root)
  if (step.name === 'publish') return publish(db)
  if (step.name === 'pack') return pack(db, root, plan)
  if (step.name === 'score') return score(db, root, plan, step)
  return { outcome: 'pass', spans: [], note: step.name }
}

function railed(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const judged = preReview(db, root, plan, wire)
  const repo = repoOf(db, plan)
  if (judged.outcome === 'pass' && judged.held !== true && repo !== null) reviewable(root, plan, repo, wire)
  return judged
}

/**
 * Jobs are held apart on the paths their briefs named, and a build that wrote outside that list
 * breaks the promise silently. So every path the build wrote outside it goes into `plan_files` as a stray -- which
 * `sharing()` in store/files.ts reads on the next pick, and the rails do not -- and one an older job is building holds
 * this job here, that job named, until it settles. A path nobody else holds goes on to the rails.
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

/** The plan `strayed` holds this one on, read back from the paths it recorded, since the hold itself is not stored. */
export function heldOn(db: Db, plan: PlanRow): number | null {
  if (mapOf(plan.template).at(plan.step).name !== 'rails') return null
  return building(db, plan.id, recorded(db, plan.id))?.plan ?? null
}

/** A ticket with an `After:` line is not briefed until the plan of the issue it names lands; one that never will is held for a person. */
function after(db: Db, root: string, plan: PlanRow): Outcome | null {
  const ref = originRef(plan)
  if (ref === null) return null
  const ticket = db.prepare('SELECT after FROM tickets WHERE repo = ? AND number = ?').get(ref.repo, ref.no) as { after: number | null } | undefined
  const n = ticket?.after ?? null
  if (n === null) return null
  const pred = db.prepare(`SELECT p.id, p.state, t.closed_at FROM plans p LEFT JOIN tickets t ON t.repo = ? AND t.number = ?
    WHERE p.origin = ? ORDER BY p.id DESC LIMIT 1`).get(ref.repo, n, `https://github.com/${ref.repo}/issues/${String(n)}`) as
    { id: number; state: PlanRow['state']; closed_at: string | null } | undefined
  if (pred?.state === 'done') return null
  const open = pred?.closed_at === null &&['queued', 'running', 'blocked_on_ceo'].includes(pred.state)
  const why = pred === undefined ? `#${String(n)} has no plan`
    : open ? `waits for #${String(n)}, plan ${String(pred.id)}, to land`
    : pred.closed_at === null ? `#${String(n)}'s plan ${String(pred.id)} ended ${pred.state}`
    : `#${String(n)} closed without plan ${String(pred.id)} landing`
  hold(db, root, plan.id, why, new Date(), open ? pred.id : null)
  if (!open) held(db, plan.id, 'coo', why)
  return { outcome: 'pass', held: true, spans: [`#${String(n)}`], note: why }
}

export function measure(db: Db, root: string, plan: PlanRow, read?: Read): Outcome {
  const gated = after(db, root, plan)
  if (gated !== null) return gated
  if (internal(plan)) return { outcome: 'pass', spans: [], note: `${homeOf(plan)}#${String(originIssue(plan))} is ours; no account to measure` }
  const row = target(db, plan)
  if (row === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const span = `targets/${row.repo}#${String(row.issue_no)}`
  if (row.state !== 'ready' && row.state !== 'queued') return { outcome: 'refuse', spans: [span], note: `target state ${row.state}` }
  const rule = waits(db, root, row.repo, row.issue_no, read)
  if (rule !== null) {
    waiting(db, [{ plan: plan.id, why: 'target_parked' }])
    return { outcome: 'refuse', held: true, spans: [span], note: `target_parked: ${rule}` }
  }
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
