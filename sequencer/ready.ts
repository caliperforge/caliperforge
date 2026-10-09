import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ready as readyRail, type Proof } from '../rails/ready/index.ts'
import { record as recordRail } from '../rails/record.ts'
import { parse } from '../rails/diff.ts'
import { digestOf, headDigest } from '../store/approvals.ts'
import { botClean, built, gated, newest, ready as readyRow, type DeliverableRow, type Made, type Proven } from '../store/deliverables.ts'
import { record as recordFiles } from '../store/files.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { allPlans, internal, stampHead, type PlanRow } from '../store/plans.ts'
import { evidenceOf, lastCi, passed, railedParts, target, targetRepo, unanswered } from '../store/ready.ts'
import { diffAt } from '../store/refusals.ts'
import { graded, greptiled } from '../store/signals.ts'
import type { Step } from '../templates/pr-path.ts'
import { writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { forkCi, headOf, holding, rehearsalBranch, title, WIRE, type Wire } from './push.ts'
import { cloned, diffOf, FORK, get, headSha, maybe, put, repoName, srcDir } from './workspace.ts'
import { homeOf } from './home.ts'
import { learned } from './learn.ts'
import { baseMoved } from './merge.ts'
import { stacked } from './stacked.ts'
import { unruled } from './unruled.ts'

export { proven, target, unanswered, type Target } from '../store/ready.ts'

export const CREDITS = 50

const FIRST_ONLY = 40

export const ASKED = 'greptile.asked'

export function monthly(root: string, now: Date): number {
  const month = now.toISOString().slice(0, 7)
  const work = join(root, '.cf/work')
  if (!existsSync(work)) return 0
  return readdirSync(work)
    .flatMap((plan) => (maybe(root, Number(plan), ASKED) ?? '').split('\n'))
    .filter((l) => l.split(' ')[1]?.startsWith(month) === true).length
}

export function reviewed(db: Db, now: Date): number {
  return greptiled(db, `${FORK}/*`, now.toISOString().slice(0, 7))
}

export function readyGate(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const moved = baseMoved(db, root, plan)
  if (moved !== null) return moved
  const repo = repoOf(db, plan)
  if (repo === null) return { outcome: 'refuse', spans: ['targets'], note: `plan ${String(plan.id)} has no target row` }
  const row = newest(db, plan.id)
  if (row === null) return { outcome: 'refuse', spans: ['deliverables'], note: `plan ${String(plan.id)} has no deliverable row` }
  if (!cloned(srcDir(root, plan.id))) return { outcome: 'refuse', spans: ['checkout'], note: `plan ${String(plan.id)} has no checkout to send` }
  if (row.state === 'built' || row.diff_digest !== digestOf(diffOf(root, plan.id))) {
    return { outcome: 'pass', spans: ['ready.unproven'], rewind: 3, note: 'the head\'s bytes are not the ones senior passed; back to the rails' }
  }
  const stack = stacked(root, plan, repo, (wire ?? WIRE).merged)
  if (stack !== null) return stack
  const waiting = forkCi(db, root, plan, repo, wire)
  if (waiting !== null) return waiting
  const bot = internal(plan) ? '' : greptile(db, root, plan, repo, wire ?? WIRE, row.diff_digest)
  if (typeof bot !== 'string') return bot
  const fresh = clean(db, root, plan)
  botClean(db, plan.id, fresh)
  const verdict = readyRail(proofOf(db, root, plan, repo, { ...row, bot_clean: Number(fresh) }))
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}${bot}` }
}

/** Ticks an outside head waits for Greptile's score before ready goes on without one. */
export const GRADING = 45

/** Nothing leaves our fork with an open P0–P2 Greptile finding at this head, nor below 4/5 with none listed. */
function greptile(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire, diff: string): Outcome | string {
  const sha = headOf(root, plan.id).sha
  const at = `${FORK}/${repoName(repo)}@${sha.slice(0, 12)}`
  const row = graded(db, plan.id, sha)
  if (row === null) {
    return asked(root, plan.id, sha, repo, wire)
      ?? holding(root, plan.id, sha, ['greptile.missing'], `${at} has no Greptile score yet`, GRADING, 'greptile.waits')
      ?? `; Greptile gave no score in ${String(GRADING)} ticks`
  }
  const score = row.score ?? 0
  const { found, ruled, open, refused } = unruled(root, plan.id, sha, row.body ?? '')
  if (open.length > 0 || (score < 4 && found === 0)) {
    const same = diffAt(db, plan.id, plan.step) === diff
    const why = refused.length > 0 ? `the COO accepted ${refused.join(', ')}, but a P1 needs a ruling citing the code; back to the builder with its findings`
      : same ? 'the diff is unchanged since the last ready refusal' : 'back to the builder with its findings'
    return { outcome: 'refuse', spans: [`greptile:${String(score)}/5`], message: row.body ?? '', to: same && refused.length === 0 ? plan.step : 2,
      note: `Greptile scored ${at} ${String(score)}/5; ${why}` }
  }
  if (ruled.length === 0) return ''
  logged(db, { plan: plan.id, kind: 'greptile.accepted', actor: 'ready', outcome: 'pass', message: ruled.join(', '), pointer: at, run: null })
  return `; Greptile scored ${at} ${String(score)}/5; the COO accepted ${ruled.join(', ')}`
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
  const ci = lastCi(db, plan.id)
  return {
    repo,
    ours: internal(plan),
    at: new Date().toISOString().slice(0, 10),
    tests_pass: row.tests_pass === 1,
    byte_identical_elsewhere: row.byte_identical_elsewhere === 1,
    bot_clean: row.bot_clean === 1,
    ci: green(ci),
    spans: [row.diff_digest.slice(0, 12)],
    title: title(root, plan.id),
    named: [maybe(root, plan.id, 'ask.md') ?? '', ...parse(diffOf(root, plan.id)).flatMap((f) => f.added.map((l) => l.text))].join('\n'),
  }
}

/** The repository the ready rail reads a pulse for. Ours has none to read, and needs none. */
export function repoOf(db: Db, plan: PlanRow): string | null {
  if (plan.target_id === null) return homeOf(plan)
  return targetRepo(db, plan.target_id)
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

/** What the step leaves in the store where it proved it: the file list at the brief, the handback at build, the gates at senior, the rail at ready. */
export function proved(db: Db, root: string, plan: PlanRow, step: Step): void {
  if (step.fires === 'brief') recordFiles(db, plan.id, writable(get(root, plan.id, 'issue.md')))
  if (step.name === 'build') built(db, made(db, root, plan, step))
  if (step.name === 'senior') gated(db, made(db, root, plan, step), proof(db, root, plan))
  if (step.name === 'ready') {
    readyRow(db, plan.id)
    const sha = headOf(root, plan.id).sha
    stampHead(db, plan.id, headDigest(sha))
    learned(db, root, plan.id, sha)
  }
}

function made(db: Db, root: string, plan: PlanRow, step: Step): Made {
  return { plan: plan.id, step: step.step, seat: step.seat, diff_digest: digestOf(diffOf(root, plan.id)), evidence: evidenceOf(db, plan) }
}

/** Each of the five is a row somebody else wrote: a gate verdict, the ci-green rail, a bot signal, the account pulse. */
function proof(db: Db, root: string, plan: PlanRow): Proven {
  const parts = railedParts(db, plan.id)
  const railed = parts.length === 0 ? [plan.id] : parts
  return {
    tests_pass: railed.every((id) => passed(db, id, 'gate', 'pre_review')),
    byte_identical_elsewhere: railed.every((id) => passed(db, id, 'gate', 'review')) && passed(db, plan.id, 'gate', 'senior_review'),
    fork_ci_green: passed(db, plan.id, 'rail_id', 'ci-green'),
    bot_clean: clean(db, root, plan),
    target_warm: internal(plan) || target(db, plan)?.state !== 'parked',
  }
}

function clean(db: Db, root: string, plan: PlanRow): boolean {
  const src = srcDir(root, plan.id)
  const head = cloned(src) ? headSha(src) : undefined
  const forkClean = internal(plan) || head === undefined || unruled(root, plan.id, head).open.length === 0
  return unanswered(db, plan.id, head) === undefined && forkClean
}

/** Raises the newest row of each step-6 plan a ruling after senior made clean; only the ready gate lowers it. */
export function rescored(db: Db, root: string): void {
  for (const plan of allPlans(db)) {
    if (plan.template !== 'pr_path' || plan.step !== 6 || !['queued', 'running'].includes(plan.state)) continue
    if (newest(db, plan.id)?.bot_clean === 0 && clean(db, root, plan)) botClean(db, plan.id, true)
  }
}
