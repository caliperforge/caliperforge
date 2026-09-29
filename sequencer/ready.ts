import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import { parse } from '../rails/diff.ts'
import { digestOf, headDigest } from '../store/approvals.ts'
import { built, gated, newest, ready as readyRow, type DeliverableRow, type Made, type Proven } from '../store/deliverables.ts'
import { record as recordFiles } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { BUILT, internal, stampHead, type PlanRow } from '../store/plans.ts'
import { graded } from '../store/signals.ts'
import type { Step } from '../templates/pr-path.ts'
import { writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { forkCi, headOf, holding, rehearsalBranch, title, WIRE, type Wire } from './push.ts'
import { cloned, diffOf, FORK, get, maybe, put, repoName, srcDir } from './workspace.ts'
import { assembling, homeOf } from './home.ts'
import { baseMoved } from './merge.ts'

export const CREDITS = 50

export const FIRST_ONLY = 40

export const ASKED = 'greptile.asked'

export function monthly(root: string, now: Date): number {
  const month = now.toISOString().slice(0, 7)
  const work = join(root, '.cf/work')
  if (!existsSync(work)) return 0
  return readdirSync(work)
    .flatMap((plan) => (maybe(root, Number(plan), ASKED) ?? '').split('\n'))
    .filter((l) => l.split(' ')[1]?.startsWith(month) === true).length
}

export interface Target { repo: string; issue_no: number; state: string; measured_at: string; pulse: string }

export function readyGate(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const moved = baseMoved(db, root, plan)
  if (moved !== null) return moved
  const repo = repoOf(db, plan)
  if (repo === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const row = newest(db, plan.id)
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

function proofOf(db: Db, root: string, plan: PlanRow, repo: string, row: DeliverableRow): Proof {
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
  return newest(db, plan)?.fork_ci_green === 1
}

/** The repository the ready rail reads a pulse for. Ours has none to read, and needs none (#20). */
export function repoOf(db: Db, plan: PlanRow): string | null {
  if (plan.target_id === null) return homeOf(plan)
  const row = db.prepare('SELECT repo FROM targets WHERE id = ?').get(plan.target_id) as { repo: string } | undefined
  return row?.repo ?? null
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

/**
 * The pulse is the repo's latest measurement — the row `rails/ready` already reads
 * (`rails/ready/index.ts:44`), not the one `cf queue add` froze in `targets.account_id`,
 * or a `cf measure` would refresh nothing the kernel reads. What the CEO approved is
 * still pinned by `targets.evidence_measured_at` in `targetDigest()`.
 */
export function target(db: Db, plan: PlanRow): Target | null {
  const row = db.prepare(`SELECT t.repo, t.issue_no, t.state, a.measured_at, a.pulse
    FROM targets t JOIN accounts a ON a.repo = t.repo
    WHERE t.id = ? ORDER BY a.measured_at DESC LIMIT 1`).get(plan.target_id)
  return (row ?? null) as Target | null
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
  const railed = assembling(db, plan) === null ? [plan.id] : partsOf(db, plan.id)
  return {
    tests_pass: railed.every((id) => passed(db, id, 'gate', 'pre_review')),
    byte_identical_elsewhere: railed.every((id) => passed(db, id, 'gate', 'review')) && passed(db, plan.id, 'gate', 'senior_review'),
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

/** An assembling parent runs no rails or review of its own: each part passed them on the bytes it put on the branch. */
function partsOf(db: Db, plan: number): number[] {
  return (db.prepare('SELECT plan FROM parts WHERE parent = ? AND plan IS NOT NULL').all(plan) as { plan: number }[]).map((p) => p.plan)
}

function passed(db: Db, plan: number, column: 'gate' | 'rail_id', value: string): boolean {
  const row = db.prepare(`SELECT outcome FROM verdicts WHERE plan = ? AND ${column} = ? ORDER BY id DESC LIMIT 1`)
    .get(plan, value) as { outcome: string } | undefined
  return row?.outcome === 'pass'
}

/** The four the gates left at senior. The fifth, fork CI, is the ready step's own first act. */
export function proven(db: Db, plan: PlanRow): boolean {
  return db.prepare(`SELECT 1 FROM deliverables WHERE plan_id = ? AND tests_pass = 1
    AND byte_identical_elsewhere = 1 AND bot_clean = 1 AND target_warm = 1`)
    .get(plan.id) !== undefined
}
