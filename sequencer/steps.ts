import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import { digestOf, gates, headDigest } from '../store/approvals.ts'
import { approved as settle, built, gated, ready as readyRow, type Made, type Proven } from '../store/deliverables.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, stampHead, type PlanRow } from '../store/plans.ts'
import { at, type Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { preReview } from './rails.ts'
import { forkCi, headOf, land, push, type Wire } from './push.ts'
import { abortMerge, behindMain, cloned, conflicted, diffOf, fetchMain, maybe, mergeMain, put, SELF, srcDir, unmerged } from './workspace.ts'

interface Target { repo: string; issue_no: number; state: string; measured_at: string; pulse: string }

export function blocked(db: Db, plan: PlanRow, today: string): string | null {
  const step = at(plan.step)
  if (step.fires === 'ceo') return internal(plan) || approvedPlan(db, plan) ? null : 'awaiting the sign-off batch'
  if (step.name === 'ruling') return internal(plan) || approved(db, plan) ? null : 'awaiting cf approve target'
  if (step.name === 'ready') return proven(db, plan) ? null : 'awaiting the ready proof'
  const row = target(db, plan)
  if (row?.state === 'parked') return `${row.repo}#${String(row.issue_no)} parked on a cold pulse`
  return stale(db, plan, today)
}

export function kernel(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const step = at(plan.step)
  if (step.name === 'rails') return freshBase(root, plan) ?? preReview(db, root, plan)
  if (step.name === 'measure') return measure(db, plan)
  if (step.name === 'ready') return readyGate(db, root, plan, wire)
  if (step.name === 'batch') return batch(db, root, plan, wire)
  if (step.name === 'push') return push(db, root, plan, wire)
  return { outcome: 'pass', spans: [], note: step.name }
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
  const moved = baseMoved(root, plan)
  if (moved !== null) return moved
  const head = plan.head_digest
  if (head === null) return { outcome: 'refuse', spans: ['plans'], note: `plan ${String(plan.id)} reached batch with no proved head` }
  const approval = db.transaction(() => {
    const id = gates(db, plan.id, head)
    settle(db, plan.id, id)
    return id
  })()
  return land(db, root, plan, approval, wire)
}

function readyGate(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const moved = baseMoved(root, plan)
  if (moved !== null) return moved
  const repo = repoOf(db, plan)
  if (repo === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const row = gatedRow(db, plan.id)
  if (row === null) return { outcome: 'refuse', spans: ['deliverables'], note: `plan ${String(plan.id)} has no deliverable row` }
  const waiting = forkCi(db, root, plan, repo, wire)
  if (waiting !== null) return waiting
  const verdict = readyRail(db, proofOf(db, plan, repo, row))
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}` }
}

/**
 * Step 3's base, #35 rule 3 one tick before the ready and batch gates: a merge returns no outcome,
 * so the rails judge the merged tree in this same tick, and it spends none of the `base.merged`
 * budget those two count their one miss against. A conflict is the builder's to settle, so the
 * refusal names the unmerged paths and rewinds onto the build. A tick that stopped inside a merge
 * left that merge open, and its bytes were committed before it, so the abort loses nothing and this
 * tick merges again from the old base.
 */
function freshBase(root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src)) return null
  if (conflicted(src)) abortMerge(src)
  const main = fetchMain(src)
  if (!behindMain(src)) return null
  const paths = takeMain(root, plan.id, src, main)
  if (paths === null) return null
  return { outcome: 'refuse', spans: paths, note: 'main moved and the branch conflicts with it', rewind: 2 }
}

/**
 * The one merge, for step 3 and for the ready and batch gates. The builder's work is committed
 * first: a merge into a dirty tree is the one way main's bytes and the seat's could be lost against
 * each other -- and never over unmerged paths, or conflict markers are what the plan's bytes turn
 * out to be. A merge that cannot be made leaves the branch on its old base and answers with the
 * paths it stopped on.
 */
function takeMain(root: string, plan: number, src: string, main: string): string[] | null {
  if (conflicted(src)) return unmerged(src)
  headOf(root, plan)
  try {
    mergeMain(src)
  } catch {
    const paths = unmerged(src)
    abortMerge(src)
    return paths
  }
  put(root, plan, 'base.sha', `${main}\n`)
  return null
}

/**
 * #35 rule 3: nothing lands over a moved main. The first miss merges main into the branch and sends
 * the plan back to the rails, which judge the merged bytes; a second miss is a branch that cannot
 * keep up with main and refuses so it is cut again. A tree still carrying unmerged paths this late
 * is cut again too, `base:conflict`: past step 3 no builder is coming back to settle them.
 */
function baseMoved(root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src)) return null
  if (conflicted(src)) return cutAgain('base:conflict', 'the checkout has unmerged paths from a tick that stopped mid-merge')
  const main = fetchMain(src)
  if (!behindMain(src)) return null
  if (maybe(root, plan.id, 'base.merged') !== null) return cutAgain('base:stale', 'the branch is behind main a second time')
  if (takeMain(root, plan.id, src, main) !== null) return cutAgain('base:conflict', 'the branch conflicts with main')
  put(root, plan.id, 'base.merged', `${main}\n`)
  return { outcome: 'pass', spans: ['base:stale'], note: 'main moved; merged it and re-ran the rails', rewind: 3 }
}

function cutAgain(span: 'base:stale' | 'base:conflict', note: string): Outcome {
  return { outcome: 'refuse', spans: [span], note: `${note}; cut it again from main` }
}

interface Gated { tests_pass: number; byte_identical_elsewhere: number; bot_clean: number; diff_digest: string }

/** The row senior left, read before the branch is sent: `forkCi` has no row to stamp without one. */
function gatedRow(db: Db, plan: number): Gated | null {
  return (db.prepare(`SELECT tests_pass, byte_identical_elsewhere, bot_clean, diff_digest
    FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1`).get(plan) ?? null) as Gated | null
}

function proofOf(db: Db, plan: PlanRow, repo: string, row: Gated): Proof {
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
  if (internal(plan)) return SELF
  const row = db.prepare('SELECT repo FROM targets WHERE id = ?').get(plan.target_id) as { repo: string } | undefined
  return row?.repo ?? null
}

export function measure(db: Db, plan: PlanRow): Outcome {
  if (internal(plan)) return { outcome: 'pass', spans: [], note: `${SELF}#${String(originIssue(plan))} is ours; no account to measure` }
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
export function targetOf(db: Db, plan: PlanRow): { repo: string; issue_no: number } | null {
  const row = db.prepare('SELECT repo, issue_no FROM targets WHERE id = ?').get(plan.target_id)
  return (row ?? null) as { repo: string; issue_no: number } | null
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

function stale(db: Db, plan: PlanRow, today: string): string | null {
  const row = target(db, plan)
  if (row === null) return null
  const days = Math.floor((Date.parse(today) - Date.parse(row.measured_at.slice(0, 10))) / 86400000)
  return days > 30 ? `account evidence is ${String(days)} days old, re-measure` : null
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

/** The deliverable row is written where the step proved it: the handback at build, the gates at senior, the rail at ready. */
export function proved(db: Db, root: string, plan: PlanRow, step: Step): void {
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
  const today = new Date().toISOString().slice(0, 10)
  return {
    tests_pass: passed(db, plan.id, 'gate', 'pre_review'),
    byte_identical_elsewhere: passed(db, plan.id, 'gate', 'review') && passed(db, plan.id, 'gate', 'senior_review'),
    fork_ci_green: passed(db, plan.id, 'rail_id', 'ci-green'),
    bot_clean: db.prepare("SELECT 1 FROM signals WHERE plan = ? AND kind = 'bot_review' AND score < 5")
      .get(plan.id) === undefined,
    target_warm: internal(plan) || (target(db, plan)?.pulse === 'warm' && stale(db, plan, today) === null),
  }
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
