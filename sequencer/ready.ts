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
import { template } from '../store/facts.ts'
import { profile } from '../store/profile.ts'
import { evidenceOf, lastCi, passed, pushTarget, railedParts, target, targetRepo, unanswered } from '../store/ready.ts'
import { diffAt } from '../store/refusals.ts'
import { graded, greptiled } from '../store/signals.ts'
import type { Step } from '../templates/pr-path.ts'
import { writable } from './brief.ts'
import type { Outcome } from './kind.ts'
import { prBody, refOf } from './pr.ts'
import { forkCi, GRADES, headOf, holding, rehearsalBranch, title, WIRE, type Wire } from './push.ts'
import { cloned, diffOf, FORK, get, git, headSha, MAIN, maybe, put, repoName, srcDir, tried } from './workspace.ts'
import { unhandled } from './handled.ts'
import { forkOf, homeOf } from './home.ts'
import { learned } from './learn.ts'
import { baseMoved } from './merge.ts'
import { stacked } from './stacked.ts'
import { unruled } from './unruled.ts'

export { proven, target, unanswered, type Target } from '../store/ready.ts'

export const CREDITS = 50

export const ASKED = 'greptile.asked'

export const SKIPPED = 'greptile.skipped'

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
  const bare = unsigned(root, plan, repo)
  if (bare !== null) return bare
  const stack = stacked(root, plan, repo, (wire ?? WIRE).merged)
  if (stack !== null) return stack
  const fork = forkOf(root, plan)
  const waiting = forkCi(db, root, plan, fork ?? repo, wire)
  if (waiting !== null) return waiting
  const bot = internal(plan) ? '' : unhandled(root, plan.id, greptile(db, root, plan, repo, wire ?? WIRE, row.diff_digest))
  if (typeof bot !== 'string') return bot
  const fresh = clean(db, root, plan)
  botClean(db, plan.id, fresh)
  const verdict = readyRail(proofOf(db, root, plan, repo, { ...row, bot_clean: Number(fresh) }))
  recordRail(db, join(root, 'rails/ready'), plan.id, verdict, 0)
  return { outcome: verdict.outcome, spans: verdict.spans, note: `ready: ${verdict.message}${bot}${fork === null ? '' : `; ${lastCi(db, plan.id)?.message ?? ''}`}` }
}

/** Upstream's commits and those our fork already shows are never judged: neither can be re-signed without a force push. */
function unsigned(root: string, plan: PlanRow, repo: string): Outcome | null {
  if (profile(root, repo)?.signed !== true) return null
  const dir = srcDir(root, plan.id)
  const shown = `refs/remotes/origin/${git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()}`
  const fork = tried(dir, ['rev-parse', '-q', '--verify', shown]) === null ? [] : [`^${shown}`]
  const sha = git(dir, ['rev-list', 'HEAD', `^${MAIN}`, ...fork]).split('\n').filter((s) => s !== '')
    .find((s) => !/^gpgsig /m.test(git(dir, ['cat-file', 'commit', s])))
  return sha === undefined ? null
    : { outcome: 'refuse', spans: ['ready.unsigned'], note: `${sha.slice(0, 12)} is unsigned and ${repo} requires signed commits` }
}

/** Ticks an outside head waits for its score before ready holds it as `needs_coo`. */
export const GRADING = 45

/** Nothing leaves our fork with an open P0–P2 Greptile finding at this head, nor below 4/5 with none listed. */
function greptile(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire, diff: string): Outcome | string {
  const sha = headOf(root, plan.id).sha
  const fork = `${FORK}/${repoName(repo)}`
  const at = `${fork}@${sha.slice(0, 12)}`
  const row = graded(db, plan.id, sha)
  if (row === null) {
    if (wire.greptile?.(fork) === false) {
      return { outcome: 'refuse', spans: ['greptile.installed'], to: plan.step, note: `Greptile is not installed on ${fork}` }
    }
    const asks = (maybe(root, plan.id, ASKED) ?? '').split('\n')
    return (asks.some((l) => l.startsWith(`${sha} `)) ? null : asked(root, plan.id, sha, fork, wire))
      ?? holding(root, plan.id, sha, ['greptile.missing'], `${at} has no Greptile score yet`, GRADING, GRADES)
      ?? { outcome: 'needs_coo', spans: ['greptile.missing'], note: `${at} has no Greptile score after ${String(GRADING)} ticks; held for the COO` }
  }
  const score = row.score ?? 0
  const { found, ruled, open, refused, severe } = unruled(root, plan.id, sha, row.body ?? '', /^G/)
  if (open.length > 0 || (score < 4 && found === 0)) {
    const same = diffAt(db, plan.id, plan.step) === diff
    const back = refused.length > 0 || (!same && (severe.length > 0 || (score < 4 && found === 0)))
    const why = refused.length > 0 ? `the COO accepted ${refused.join(', ')}, but a P1 needs a ruling citing the code; back to the builder with its findings`
      : same ? 'the diff is unchanged since the last ready refusal'
        : back ? 'back to the builder with its findings' : 'P2s are fixed in one batch before sign-off; Greptile is not asked again'
    return { outcome: 'refuse', spans: [`greptile:${String(score)}/5`], message: row.body ?? '', to: back ? 2 : plan.step,
      note: `Greptile scored ${at} ${String(score)}/5; ${why}` }
  }
  if (ruled.length === 0) return ''
  logged(db, { plan: plan.id, kind: 'greptile.accepted', actor: 'ready', outcome: 'pass', message: ruled.join(', '), pointer: at, run: null })
  return `; Greptile scored ${at} ${String(score)}/5; the COO accepted ${ruled.join(', ')}`
}

function asked(root: string, plan: number, sha: string, fork: string, wire: Wire): Outcome | null {
  const month = monthly(root, new Date())
  if (month >= CREDITS) {
    const why = `monthly quota spent (${String(month)}/${String(CREDITS)})`
    put(root, plan, SKIPPED, `${sha} ${why}\n`)
    return { outcome: 'needs_coo', spans: ['greptile.quota'], note: `${fork}@${sha.slice(0, 12)} not asked: ${why}; held for the COO` }
  }
  wire.review(fork, rehearsalBranch(root, plan))
  put(root, plan, ASKED, `${maybe(root, plan, ASKED) ?? ''}${sha} ${new Date().toISOString()}\n`)
  return null
}

function proofOf(db: Db, root: string, plan: PlanRow, repo: string, row: DeliverableRow): Proof {
  const ci = lastCi(db, plan.id)
  const to = internal(plan) ? null : pushTarget(db, plan)
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
    ...(to === null ? { body: '', template: null, closes: null } : posted(root, plan.id, to.issue_no, repo)),
  }
}

/** The body step 8 posts, their PR template, and the closing line their profile requires. */
function posted(root: string, plan: number, no: number, repo: string): Pick<Proof, 'body' | 'template' | 'closes'> {
  const theirs = template(srcDir(root, plan))
  const rules = profile(root, repo, plan)
  return {
    body: maybe(root, plan, 'pr.md') ?? prBody(no, root, plan, rules),
    template: theirs ?? null,
    closes: refOf(theirs, rules) === 'Fixes' ? `Fixes #${String(no)}` : null,
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

/** Reads now what the step leaves in the store where it proved it, and returns the function that writes those rows: the file list at the brief, the handback at build, the gates at senior, the rail at ready. */
export function proved(db: Db, root: string, plan: PlanRow, step: Step): () => void {
  if (step.fires === 'brief') { const files = writable(get(root, plan.id, 'issue.md')); return () => { recordFiles(db, plan.id, files) } }
  if (step.name === 'build') { const m = made(db, root, plan, step); return () => { built(db, m) } }
  if (step.name === 'senior') { const m = made(db, root, plan, step); const p = proof(db, root, plan); return () => { gated(db, m, p) } }
  if (step.name !== 'ready') return () => undefined
  const sha = headOf(root, plan.id).sha
  learned(db, root, plan.id, sha)
  return () => { readyRow(db, plan.id); stampHead(db, plan.id, headDigest(sha)) }
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
