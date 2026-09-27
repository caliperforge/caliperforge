import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { CHECK, find } from '../cli/find.ts'
import type { Read } from '../cli/gh.ts'
import { CARD } from '../cli/queue.ts'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import { digestOf, gates, headDigest } from '../store/approvals.ts'
import { parse } from '../rails/diff.ts'
import { approved as settle, built, gated, ready as readyRow, type Made, type Proven } from '../store/deliverables.ts'
import { building, filesOf, record as recordFiles, sharing, strays as recordStrays } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { BUILT, builderRan, internal, originIssue, stampHead, type PlanRow, type Wait } from '../store/plans.ts'
import { graded } from '../store/signals.ts'
import { at, type Step } from '../templates/pr-path.ts'
import { writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { preReview } from './rails.ts'
import { ASKED, CREDITS, FIRST_ONLY, monthly } from './ready.ts'
import { forkCi, headOf, holding, land, push, rehearsalBranch, reviewable, title, WIRE, type Wire } from './push.ts'
import { following } from './split.ts'
import { cloned, diffOf, FORK, get, maybe, put, repoName, srcDir } from './workspace.ts'
import { homeOf } from './home.ts'
import { baseMoved, freshBase } from './merge.ts'

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

function readyGate(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const moved = baseMoved(db, root, plan)
  if (moved !== null) return moved
  const repo = repoOf(db, plan)
  if (repo === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const row = gatedRow(db, plan.id)
  if (row === null) return { outcome: 'refuse', spans: ['deliverables'], note: `plan ${String(plan.id)} has no deliverable row` }
  if (!cloned(srcDir(root, plan.id))) return { outcome: 'refuse', spans: ['checkout'], note: `plan ${String(plan.id)} has no checkout to send` }
  const waiting = forkCi(db, root, plan, repo, wire)
  if (waiting !== null) return waiting
  const bot = internal(plan) ? '' : greptile(db, root, plan, repo, wire ?? WIRE)
  if (typeof bot !== 'string') return bot
  const verdict = readyRail(proofOf(db, root, plan, repo, row))
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}${bot}` }
}

/** Ticks an outside head waits for Greptile's score before ready goes on without one. */
export const GRADING = 45

/** Nothing leaves our fork below 4/5 from Greptile at this head. */
function greptile(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire): Outcome | string {
  const sha = headOf(root, plan.id).sha
  const at = `${FORK}/${repoName(repo)}@${sha.slice(0, 12)}`
  const row = graded(db, plan.id, sha)
  if (row === null) {
    return asked(root, plan.id, sha, repo, wire)
      ?? holding(root, plan.id, sha, ['greptile.missing'], `${at} has no Greptile score yet`, GRADING, 'greptile.waits')
      ?? `; Greptile gave no score in ${String(GRADING)} ticks`
  }
  const score = row.score ?? 0
  if (score >= 4) return ''
  return { outcome: 'refuse', spans: [`greptile:${String(score)}/5`], message: row.body ?? '', to: 2,
    note: `Greptile scored ${at} ${String(score)}/5; back to the builder with its findings` }
}

/** Greptile's plan gives {@link CREDITS} credits a month, so a job asks for at most this many reviews. */
const ASKS = 3

function asked(root: string, plan: number, sha: string, repo: string, wire: Wire): Outcome | null {
  const text = maybe(root, plan, ASKED) ?? ''
  const heads = text.split('\n').filter((l) => l !== '').map((l) => l.split(' ')[0])
  if (heads.includes(sha)) return null
  if (heads.length >= ASKS) {
    return { outcome: 'needs_ceo', spans: ['greptile.requests'],
      note: `Greptile was asked ${String(ASKS)} times on this job; asking again at ${sha.slice(0, 12)} is the COO's call` }
  }
  const month = heads.length === 0 ? 0 : monthly(root, new Date())
  if (month >= FIRST_ONLY) {
    return { outcome: 'needs_ceo', spans: ['greptile.month'],
      note: `Greptile was asked ${String(month)}/${String(CREDITS)} times this month; another review at ${sha.slice(0, 12)} is the COO's call` }
  }
  wire.review(`${FORK}/${repoName(repo)}`, rehearsalBranch(root, plan))
  put(root, plan, ASKED, `${text}${sha} ${new Date().toISOString()}\n`)
  return null
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
  return db.prepare(`SELECT 1 FROM signals s WHERE s.plan = ? AND s.kind = 'bot_review' AND s.score < 5 AND s.repo NOT GLOB ?
    AND julianday(s.at) > coalesce((SELECT max(julianday(r.at)) FROM runs r WHERE r.plan = ? AND r.step = 2 AND r.${BUILT}), 0)`)
    .get(plan, `${FORK}/*`, plan)
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
