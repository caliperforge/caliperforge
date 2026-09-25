import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import { keep, last as lastMerge, lastReview, record as recordMerge } from '../store/merges.ts'
import { digestOf, gates, headDigest } from '../store/approvals.ts'
import { parse } from '../rails/diff.ts'
import { approved as settle, built, gated, ready as readyRow, type Made, type Proven } from '../store/deliverables.ts'
import { building, filesOf, record as recordFiles, sharing, strays as recordStrays } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { builderRan, internal, originIssue, stampHead, type PlanRow, type Wait } from '../store/plans.ts'
import { at, type Step } from '../templates/pr-path.ts'
import { writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { preReview } from './rails.ts'
import { forkCi, headOf, land, opened, push, reviewable, title, type Wire } from './push.ts'
import { following } from './split.ts'
import { abortMerge, behindMain, cloned, conflicted, diffOf, diffSince, fetchMain, get, holds, maybe, merging, mergeMain, narrowing, put, recut, srcDir,
  unmerged } from './workspace.ts'
import { classify } from './delta.ts'
import { homeOf } from './home.ts'

interface Target { repo: string; issue_no: number; state: string; measured_at: string; pulse: string }

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

export function kernel(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const step = at(plan.step)
  if (step.name === 'rails') return freshBase(db, root, plan) ?? strayed(db, root, plan) ?? railed(db, root, plan, wire)
  if (step.name === 'measure') return measure(db, plan)
  if (step.name === 'ready') return readyGate(db, root, plan, wire)
  if (step.name === 'batch') return batch(db, root, plan, wire)
  if (step.name === 'push') return push(db, root, plan, wire)
  return { outcome: 'pass', spans: [], note: step.name }
}

function railed(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const judged = preReview(db, root, plan)
  const repo = repoOf(db, plan)
  if (judged.outcome === 'pass' && judged.held !== true && repo !== null) reviewable(db, root, plan, repo, wire)
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

function readyGate(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const moved = baseMoved(db, root, plan)
  if (moved !== null) return moved
  const repo = repoOf(db, plan)
  if (repo === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const row = gatedRow(db, plan.id)
  if (row === null) return { outcome: 'refuse', spans: ['deliverables'], note: `plan ${String(plan.id)} has no deliverable row` }
  const waiting = forkCi(db, root, plan, repo, wire)
  if (waiting !== null) return waiting
  const verdict = readyRail(proofOf(db, root, plan, repo, row))
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}` }
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

/**
 * Step 3's base, #35 rule 3 one tick before the ready and batch gates: a merge returns no outcome,
 * so the rails judge the merged tree in this same tick, and it spends none of the `base.merged`
 * budget those two count their one miss against. A conflict is the builder's to settle, so the
 * refusal names the unmerged paths and rewinds onto the build. A tick that stopped inside a merge
 * left that merge open, and its bytes were committed before it, so the abort loses nothing and this
 * tick merges again from the old base. #162: the rewind alone would hand the builder that same old
 * base, so the checkout is cut again from main and the builder's diff carried across to be re-applied.
 */
function freshBase(db: Db, root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src) || shown(db, plan)) return null
  if (conflicted(src)) abortMerge(src)
  const main = fetchMain(src)
  if (!behindMain(src, main)) return null
  const paths = takeMain(db, root, plan, src, main, at(plan.step).step)
  if (paths === null) return null
  recut(root, plan.id)
  return { outcome: 'refuse', spans: paths, note: 'main moved and the branch conflicts with it; cut again from main', rewind: 2, moved: true }
}

/**
 * The one merge, for step 3 and for the ready and batch gates. #130: every merge leaves its two file
 * sets and their overlap on the plan, whether it went through or conflicted; `kept()` is the decision
 * that reads them. The builder's work is committed
 * first: a merge into a dirty tree is the one way main's bytes and the seat's could be lost against
 * each other -- and never over unmerged paths, or conflict markers are what the plan's bytes turn
 * out to be. A merge that cannot be made leaves the branch on its old base and answers with the
 * paths it stopped on.
 */
function takeMain(db: Db, root: string, plan: PlanRow, src: string, main: string, step: number): string[] | null {
  if (conflicted(src)) return unmerged(src)
  headOf(root, plan.id)
  const { incoming, mine } = merging(src, get(root, plan.id, 'base.sha').trim(), main)
  const overlap = incoming.some((path) => mine.includes(path))
  try {
    mergeMain(src)
  } catch {
    const paths = unmerged(src)
    abortMerge(src)
    recordMerge(db, plan.id, step, { main, incoming, mine, overlap, clean: false })
    return paths
  }
  recordMerge(db, plan.id, step, { main, incoming, mine, overlap, clean: true })
  put(root, plan.id, 'base.sha', `${main}\n`)
  return null
}

export function kept(db: Db, root: string, plan: PlanRow, step: Step): Outcome | null {
  return merged(db, root, plan, step) ?? (step.step === 5 ? skipped(db, root, plan.id) : null)
}

/** #199: a rework whose delta since senior's pass is comments or docs alone keeps that pass. */
function skipped(db: Db, root: string, plan: number): Outcome | null {
  const given = lastReview(db, plan, 'senior_review')
  const passed = maybe(root, plan, 'step-5.passed.diff')
  const src = srcDir(root, plan)
  if (given?.outcome !== 'pass' || given.tree === null || passed === null || !holds(src, given.tree)) return null
  const changed = narrowing(src, given.tree, get(root, plan, 'base.sha').trim()).changed
  const { mode, why } = classify(passed, diffSince(src, given.tree), changed)
  if (mode !== 'comment') return null
  keep(db, plan, 5, 'senior_review', given, null)
  put(root, plan, 'step-5.mode', `skipped: ${why}\n`)
  return { outcome: 'pass', spans: [], note: `senior_review skipped: ${why}` }
}

/**
 * #131. A merge git took without help, that brought in no file the job changed, leaves the job's own diff
 * byte-identical: the reviewers already passed exactly these bytes, so their verdict stands and no seat is
 * fired. The rails and checks still run on the merged tree at step 3. Kept only for a verdict given before
 * that merge, and only while the diff is the one senior passed; anything else is a full review as before.
 */
function merged(db: Db, root: string, plan: PlanRow, step: Step): Outcome | null {
  const gate = step.verdict_gate
  const merge = lastMerge(db, plan.id)
  if (gate === null || merge === null || !merge.clean || merge.overlap || merge.verdict === null) return null
  const given = lastReview(db, plan.id, gate)
  if (given?.outcome !== 'pass' || given.id > merge.verdict) return null
  if (passedDiff(db, plan.id) !== digestOf(diffOf(root, plan.id))) return null
  keep(db, plan.id, step.step, gate, given, merge.id)
  return { outcome: 'pass', spans: [], note: `${step.runs} kept: main brought in ${String(merge.incoming.length)} file(s), none of the job's` }
}

/** The diff senior last passed, off the row its pass wrote. */
function passedDiff(db: Db, plan: number): string | null {
  const row = db.prepare("SELECT diff_digest FROM deliverables WHERE plan_id = ? AND step = 5 ORDER BY id DESC LIMIT 1")
    .get(plan) as { diff_digest: string } | undefined
  return row?.diff_digest ?? null
}

/**
 * #35 rule 3: nothing lands over a moved main. The first miss merges main into the branch and sends
 * the plan back to the rails, which judge the merged bytes. #295: a later miss, a conflict, or a tree
 * left mid-merge used to refuse with "cut it again", which nothing did: the builder had nothing to
 * change and every later move of main refused the job again. They go back to the rails instead, where
 * `freshBase` merges main or, on a conflict, cuts the checkout again and carries the build across.
 */
function baseMoved(db: Db, root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src) || shown(db, plan)) return null
  if (conflicted(src)) return toRails(root, plan, 'base:conflict', 'the checkout has unmerged paths from a tick that stopped mid-merge')
  const main = fetchMain(src)
  if (!behindMain(src, main)) return null
  if (maybe(root, plan.id, 'base.merged') !== null) return toRails(root, plan, 'base:stale', 'main moved again')
  if (takeMain(db, root, plan, src, main, at(plan.step).step) !== null) return toRails(root, plan, 'base:conflict', 'the branch conflicts with main')
  put(root, plan.id, 'base.merged', `${main}\n`)
  return { outcome: 'pass', spans: ['base:stale'], note: 'main moved; merged it and re-ran the rails', rewind: 3 }
}

/** Past this many trips back to the rails, a job that never catches main goes to a person. */
export const LAPS = 4

const LAPPED = 'base.laps'

function toRails(root: string, plan: PlanRow, span: 'base:stale' | 'base:conflict', note: string): Outcome {
  const laps = maybe(root, plan.id, LAPPED) ?? ''
  if (laps.split('\n').filter((l) => l !== '').length >= LAPS) {
    return { outcome: 'refuse', spans: [span], note: `${note}, and ${String(LAPS)} trips back to the rails have not caught main up` }
  }
  put(root, plan.id, LAPPED, `${laps}${span}\n`)
  return { outcome: 'pass', spans: [span], note: `${note}; back to the rails to take main`, rewind: 3 }
}

/** A stranger's pull request that is already open is not merged into: their main moving is theirs to settle. */
function shown(db: Db, plan: PlanRow): boolean {
  return !internal(plan) && opened(db, plan.id) !== null
}

interface Gated { tests_pass: number; byte_identical_elsewhere: number; bot_clean: number; diff_digest: string }

/** The row senior left, read before the branch is sent: `forkCi` has no row to stamp without one. */
function gatedRow(db: Db, plan: number): Gated | null {
  return (db.prepare(`SELECT tests_pass, byte_identical_elsewhere, bot_clean, diff_digest
    FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(plan) ?? null) as Gated | null
}

function proofOf(db: Db, root: string, plan: PlanRow, repo: string, row: Gated): Proof {
  const ci = db.prepare("SELECT outcome, subject_digest FROM verdicts WHERE plan = ? AND rail_id = 'ci-green' ORDER BY id DESC LIMIT 1")
    .get(plan.id) as { outcome: string; subject_digest: string } | undefined
  return {
    repo,
    ours: internal(plan),
    at: new Date().toISOString().slice(0, 10),
    tests_pass: row.tests_pass === 1,
    byte_identical_elsewhere: row.byte_identical_elsewhere === 1,
    fork_public: forkGreened(db, plan.id),
    bot_clean: row.bot_clean === 1,
    ci: green(ci),
    spans: [row.diff_digest.slice(0, 12)],
    title: title(root, plan.id),
    named: [maybe(root, plan.id, 'ask.md') ?? '', ...parse(diffOf(root, plan.id)).flatMap((f) => f.added.map((l) => l.text))].join('\n'),
  }
}

/** Read again after `forkCi`: the column it stamps is the fork-CI proof, and the row was found before it ran. */
function forkGreened(db: Db, plan: number): boolean {
  const row = db.prepare('SELECT fork_ci_green FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1')
    .get(plan) as { fork_ci_green: number } | undefined
  return row?.fork_ci_green === 1
}

/** The repository the ready rail reads a pulse for. Ours has none to read, and needs none (#20). */
function repoOf(db: Db, plan: PlanRow): string | null {
  if (internal(plan)) return homeOf(plan)
  const row = db.prepare('SELECT repo FROM targets WHERE id = ?').get(plan.target_id) as { repo: string } | undefined
  return row?.repo ?? null
}

export function measure(db: Db, plan: PlanRow): Outcome {
  if (internal(plan)) return { outcome: 'pass', spans: [], note: `${homeOf(plan)}#${String(originIssue(plan))} is ours; no account to measure` }
  const row = target(db, plan)
  if (row === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  if (row.state === 'ready' || row.state === 'queued') {
    return { outcome: 'pass', spans: [], note: `${row.repo}#${String(row.issue_no)} ${row.pulse}` }
  }
  return { outcome: 'refuse', spans: [`targets/${row.repo}#${String(row.issue_no)}`], note: `target state ${row.state}` }
}

/** No `ci-green` verdict is not a green CI. The ready gate's CI input is a row the rail wrote or a refusal. */
function green(ci: { outcome: string; subject_digest: string } | undefined): Proof['ci'] {
  const passed = ci?.outcome === 'pass'
  return {
    outcome: passed ? 'pass' : 'refuse',
    defect_class: null,
    origin_kind: passed ? null : 'rail',
    origin_ref: passed ? null : 'ci-green',
    subject_digest: ci?.subject_digest ?? '0'.repeat(64),
    spans: passed ? [] : ['ci-green'],
    message: ci === undefined ? 'ci-green left no verdict on this plan' : 'ci-green',
  }
}

/** The repository and issue a plan's checkout is made from, if it has one. */
export function targetOf(db: Db, plan: PlanRow): { repo: string; issue_no: number; part: string } | null {
  const row = db.prepare('SELECT repo, issue_no, part FROM targets WHERE id = ?').get(plan.target_id)
  return (row ?? null) as { repo: string; issue_no: number; part: string } | null
}

/**
 * The pulse is the repo's latest measurement — the row `rails/ready` already reads
 * (`rails/ready/index.ts:44`), not the one `cf queue add` froze in `targets.account_id`,
 * or a `cf measure` would refresh nothing the kernel reads. What the CEO approved is
 * still pinned by `targets.evidence_measured_at` in `targetDigest()`.
 */
function target(db: Db, plan: PlanRow): Target | null {
  const row = db.prepare(`SELECT t.repo, t.issue_no, t.state, a.measured_at, a.pulse
    FROM targets t JOIN accounts a ON a.repo = t.repo
    WHERE t.id = ? ORDER BY a.measured_at DESC LIMIT 1`).get(plan.target_id)
  return (row ?? null) as Target | null
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
  return db.prepare("SELECT 1 FROM approvals WHERE subject_kind = 'target' AND subject_id = ? AND subject_digest = ?")
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

/** What the step leaves in the store where it proved it: the file list at the brief, the handback at build, the gates at senior, the rail at ready. */
export function proved(db: Db, root: string, plan: PlanRow, step: Step): void {
  if (step.fires === 'brief') recordFiles(db, plan.id, writable(get(root, plan.id, 'issue.md')))
  if (step.name === 'build') built(db, made(db, root, plan, step))
  if (step.name === 'senior') gated(db, made(db, root, plan, step), proof(db, plan))
  if (step.name === 'ready') {
    readyRow(db, plan.id)
    stampHead(db, plan.id, headDigest(headOf(root, plan.id).sha))
  }
}

function made(db: Db, root: string, plan: PlanRow, step: Step): Made {
  return { plan: plan.id, step: step.step, seat: step.seat, diff_digest: digestOf(diffOf(root, plan.id)), evidence: evidenceOf(db, plan) }
}

/** What the deliverable row points at: the target's issue url, or the issue of ours the plan was filed from. */
function evidenceOf(db: Db, plan: PlanRow): string {
  if (plan.origin !== null) return plan.origin
  const row = db.prepare('SELECT evidence FROM targets WHERE id = ?').get(plan.target_id) as
    { evidence: string } | undefined
  if (row === undefined) throw new Error(`plan ${String(plan.id)} has no target row`)
  return row.evidence
}

/** Each of the five is a row somebody else wrote: a gate verdict, the ci-green rail, a bot signal, the account pulse. */
function proof(db: Db, plan: PlanRow): Proven {
  return {
    tests_pass: passed(db, plan.id, 'gate', 'pre_review'),
    byte_identical_elsewhere: passed(db, plan.id, 'gate', 'review') && passed(db, plan.id, 'gate', 'senior_review'),
    fork_ci_green: passed(db, plan.id, 'rail_id', 'ci-green'),
    bot_clean: unanswered(db, plan.id) === undefined,
    target_warm: internal(plan) || target(db, plan)?.state !== 'parked',
  }
}

/** A low bot score a later build has answered no longer holds the plan; the bot scores the new head once it is pushed. */
export function unanswered(db: Db, plan: number): unknown {
  return db.prepare(`SELECT 1 FROM signals s WHERE s.plan = ? AND s.kind = 'bot_review' AND s.score < 5
    AND julianday(s.at) > coalesce((SELECT max(julianday(r.at)) FROM runs r WHERE r.plan = ? AND r.step = 2), 0)`)
    .get(plan, plan)
}

function passed(db: Db, plan: number, column: 'gate' | 'rail_id', value: string): boolean {
  const row = db.prepare(`SELECT outcome FROM verdicts WHERE plan = ? AND ${column} = ? ORDER BY id DESC LIMIT 1`)
    .get(plan, value) as { outcome: string } | undefined
  return row?.outcome === 'pass'
}

/** The four the gates left at senior. The fifth, fork CI, is the ready step's own first act. */
function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}
