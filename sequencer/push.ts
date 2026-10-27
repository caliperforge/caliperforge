import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { actions, closeIssue, commentIssue, describePr, dispatch, fileIssue, gh, installed, issueComments, forward, openPr, prNumber, rehearse, review, unrehearse, type IssueComment, type Read } from '../cli/gh.ts'
import { CARD } from '../cli/queue.ts'
import { alerter } from '../cli/watch.ts'
import { judge, MISSING, PENDING, shell, type Board, type Gh, type Head as At } from '../rails/ci-green/index.ts'
import { parse } from '../rails/diff.ts'
import { record, type Verdict } from '../rails/record.ts'
import { headDigest, signedHead } from '../store/approvals.ts'
import { forkGreen, newest } from '../store/deliverables.ts'
import type { Db } from '../store/index.ts'
import { busy } from '../store/now.ts'
import { internal, originIssue, originRef, type PlanRow } from '../store/plans.ts'
import { profile, type Profile } from '../store/profile.ts'
import { markPushed, opened, passed as passing, pushTarget } from '../store/ready.ts'
import { freed, took, waitsFor } from '../store/slot.ts'
import { GREEN, onBase } from './base.ts'
import { CHECKS, waiting, type Check, type Row } from './card.ts'
import { npm } from './checks.ts'
import { bind, prMessage, signedAt } from './folded.ts'
import { red } from './failures.ts'
import { config } from './greptile.ts'
import { refresh } from './install.ts'
import { rerun as cancelled } from './rerun.ts'
import { based, moved, retire } from './retire.ts'
import type { Outcome } from './kind.ts'
import { merging } from './merging.ts'
import { prBody, prTitle } from './pr.ts'
import { assembled, cloned, conflicted, diffOf, fetchMain, FORK, MAIN, maybe, planDir, put, repoName, srcDir, titleOf, tried } from './workspace.ts'
import { assembly, homeOf, onto } from './home.ts'
import { clean, subjectOf } from './shape.ts'
import { size } from './size.ts'
import { prosed } from './tells.ts'
import { picked, theirs } from './theirs.ts'
import { dispatchable, fired, started, unrun, UNRUN } from './triggers.ts'

interface Head { dir: string; branch: string; sha: string }

/** The transport, named so a test can watch it: R4 says the send itself is never the seat's to make. */
export interface Wire {
  send: (dir: string, branch: string) => void
  open: (repo: string, head: string, title: string, bodyFile: string) => string
  describe?: (repo: string, no: number, body: string) => void
  close: (repo: string, no: number, sha: string, comment?: string) => void
  runs: Gh
  forward?: (fork: string, base: string) => void
  rehearse?: (fork: string, branch: string) => void
  unrehearse?: (fork: string, branch: string) => void
  at?: (dir: string, ref: string) => string
  review: (fork: string, branch: string) => void
  greptile?: (fork: string) => boolean
  actions?: (fork: string) => boolean
  dispatch?: (fork: string, file: string, branch: string) => void
  file: (repo: string, title: string, body: string, labels: string[]) => string
  comment: (repo: string, no: number, body: string) => void
  thread?: (repo: string, no: number) => IssueComment[]
  install?: () => void
  card?: Check[]
  intake?: Check
  merged: Read
}

export const WIRE: Wire = {
  send: (dir, branch) => void git(dir, ['push', '--set-upstream', 'origin', branch]),
  open: openPr,
  describe: describePr,
  close: closeIssue,
  file: fileIssue,
  comment: commentIssue,
  thread: issueComments,
  runs: shell,
  forward,
  rehearse,
  unrehearse,
  at: (dir, ref) => git(dir, ['ls-remote', 'origin', ref]).split('\t')[0] ?? '',
  review, greptile: installed, actions, dispatch,
  install: () => { refresh(npm, alerter()) },
  card: [theirs()],
  intake: picked(),
  merged: gh,
}

/**
 * From the first round, CI runs on this branch beside the real one: pushing the real branch would put
 * an unsigned-off round on the maintainer's screen before it is signed off.
 */
const NEXT = '-next'

/** Ticks a head is given for its first run to show; past them a head with no run is judged as it stands. */
const APPEARS = 10

/** Ticks a head whose runs are going is given to finish. Surfpool's Rust workflow takes 10 to 33 minutes. */
const FINISHES = 45

const WAITS = 'ci.waits'

const RERUNS = 'ci.waits.rerun'

export const GRADES = 'greptile.waits'

export const COUNTS = [WAITS, RERUNS, GRADES]

const REHEARSED = 'ci.next'

const ACTIONS = 'ci.actions'

/**
 * Step 6 before the gate: the branch goes to our fork -- no pull request, and the rail reads the
 * branch's own commit messages for an upstream number -- and `rails/ci-green` judges the runs at
 * that head. GitHub has no run at a head the moment the push returns, so a head with no run yet
 * waits as a run still going does. Both count on one tally: a head with no run is judged past `APPEARS`
 * ticks, one whose runs are going past `FINISHES`; then a head with no run, as a gating run still going, goes to `needs_ceo`.
 * A red run goes to the builder, not a reviewer: their CI is the only test an outside build gets.
 */
export function forkCi(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire = WIRE): Outcome | null {
  if (internal(plan) && (assembly(db, plan) !== null || !workflows(srcDir(root, plan.id)))) return checked(db, root, plan, repo)
  const holder = waitsFor(db, plan)
  if (holder !== null) return { outcome: 'pass', held: true, spans: ['fork.slot'], note: `waits for plan ${String(holder)}'s fork CI` }
  const { fork, head, ci, tip, base: onto, rejected } = sent(root, plan, repo, wire)
  if (rejected !== null) return { outcome: 'refuse', spans: ['fork.sent'], to: 6, note: rejected }
  const off = onto === null ? null : unfolded(head.dir, onto, messageOf(root, plan.id, profile(root, repo)))
  if (off !== null) return { outcome: 'refuse', spans: ['fold'], to: 2, note: off }
  if (!internal(plan)) { wire.rehearse?.(fork, ci); took(db, plan) }
  if (!workflows(head.dir)) { freed(db, plan.id); return checked(db, root, plan, repo) }
  const on = { fork, branch: ci, sha: tip }
  const early = unfired(db, root, plan, repo, head, on, wire)
  if (early !== null) return early.stop
  const { verdict, board } = judge(on, { body: '', commits: commits(head.dir), issue_ref: profile(root, repo)?.issue_ref }, touched(root, plan.id), wire.runs)
  put(root, plan.id, BOARD, `${JSON.stringify(board)}\n`)
  const at = `${fork}@${head.sha.slice(0, 12)}`
  const waiting = unfinished(verdict.spans) ?? others(board)
  const window = carries(verdict.spans, MISSING) ? APPEARS : FINISHES
  const hold = waiting === null ? null : holding(root, plan.id, head.sha, verdict.spans, `${at} ${waiting}`, window)
  if (hold !== null) return onCi(db, plan.id, hold)
  const stop = stalled(verdict.spans, board, at, fork, tip)
  if (stop !== null) { freed(db, plan.id); return stop }
  const again = waiting === null && verdict.outcome === 'refuse' ? cancelled(root, plan.id, on, verdict.spans, wire.runs) : null
  if (again !== null) {
    const rerunning = holding(root, plan.id, head.sha, verdict.spans, `${at} ${again}`, APPEARS, RERUNS)
    if (rerunning !== null) return onCi(db, plan.id, rerunning)
    freed(db, plan.id)
    return { outcome: 'needs_ceo', spans: verdict.spans, note: `${at} ${again}: still cancelled after ${String(APPEARS)} ticks` }
  }
  const base = waiting === null && verdict.outcome === 'refuse' ? onBase(root, plan.id, on, verdict.spans, board, wire.runs) : null
  const rerun = typeof base === 'string' ? holding(root, plan.id, head.sha, verdict.spans, `${at} ${base}`, FINISHES) : null
  if (rerun !== null) return onCi(db, plan.id, rerun)
  if (Array.isArray(base)) put(root, plan.id, BOARD, `${JSON.stringify(base)}\n`)
  const passed = verdict.outcome === 'pass' || Array.isArray(base)
  record(db, join(root, 'rails/ci-green'), plan.id, passed ? { ...verdict, outcome: 'pass', origin_kind: null, origin_ref: null } : verdict, 0)
  freed(db, plan.id)
  forkGreen(db, plan.id, passed)
  if (verdict.outcome === 'pass') put(root, plan.id, GREEN, `${ci} ${tip}\n`)
  return passed ? null : refused(at, verdict, red(db, plan.id, fork, verdict.spans, wire.runs))
}

function unfired(db: Db, root: string, plan: PlanRow, repo: string, head: Head, on: At, wire: Wire): { stop: Outcome | null } | null {
  const manual = fired(head.dir, on.branch, [...touched(root, plan.id), 'greptile.json']) ? null : dispatchable(head.dir)
  if (manual?.length === 0) { freed(db, plan.id); unrun(db, root, plan.id, head.sha); return { stop: checked(db, root, plan, repo, UNRUN) } }
  const dark = disabled(db, root, plan.id, head.sha, on.fork, wire)
  if (dark === null && manual !== null) started(root, plan.id, manual, on.sha, (file) => { wire.dispatch?.(on.fork, file, on.branch) })
  return dark === null ? null : { stop: dark }
}

/** Only an "on" is kept against the head, so a fork still off is asked again after `cf return`. */
function disabled(db: Db, root: string, plan: number, sha: string, fork: string, wire: Wire): Outcome | null {
  if (maybe(root, plan, ACTIONS) === sha) return null
  if (wire.actions?.(fork) ?? true) {
    put(root, plan, ACTIONS, sha)
    return null
  }
  freed(db, plan)
  return { outcome: 'needs_ceo', spans: ['fork.actions'],
    note: `${fork} has Actions off for its workflows: enable them at https://github.com/${fork}/actions, then cf return ${String(plan)}` }
}

function refused(at: string, verdict: Verdict, failed: ReturnType<typeof red>): Outcome {
  if (failed === null) return { outcome: 'refuse', spans: verdict.spans, message: verdict.message, note: `ci-green refused ${at}: ${verdict.message}` }
  return { outcome: 'refuse', spans: failed.spans, message: failed.log, to: 2, note: `their CI is red on ${at}; back to the builder with the failed log` }
}

function stalled(spans: string[], board: Board[], at: string, fork: string, tip: string): Outcome | null {
  if (carries(spans, MISSING)) return { outcome: 'needs_ceo', spans, note: `${fork} ran no workflow at ${tip.slice(0, 12)} in ${String(APPEARS)} ticks` }
  if (!carries(spans, PENDING)) return null
  const running = board.filter((r) => r.gates && r.status !== 'completed').map((r) => r.workflow).join(', ')
  return { outcome: 'needs_ceo', spans: [PENDING], note: `${at} is still running ${running} after ${String(FINISHES)} ticks` }
}

/** Step 3's pass opens the rehearsal: a review bot reads only an open pull request. */
export function reviewable(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire = WIRE): void {
  if (internal(plan)) return
  const { fork, ci, rejected } = sent(root, plan, repo, wire)
  if (rejected !== null) return
  wire.rehearse?.(fork, ci)
  took(db, plan)
}

export function sent(root: string, plan: PlanRow, repo: string, wire: Wire): { fork: string; head: Head; ci: string; tip: string; base: string | null; rejected: string | null } {
  const outside = !internal(plan)
  const fork = `${FORK}/${repoName(repo)}`
  const dir = srcDir(root, plan.id)
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const ci = outside ? rehearsed(root, plan.id, branch) : branch
  const rules = profile(root, repo)
  const base = !outside ? null : onFork(dir, branch) ? follow(root, plan.id, messageOf(root, plan.id, rules)) : squash(root, plan.id, rules)
  const head = outside ? headOf(root, plan.id) : onward(headOf(root, plan.id))
  const tip = outside ? tipOf(root, plan.id, head, ci, repo) : head.sha
  if (outside) based(root, plan.id, fork, wire)
  if (wire.at?.(head.dir, `refs/heads/${ci}`) !== tip) wire.send(head.dir, outside ? `${tip}:refs/heads/${ci}` : head.branch)
  const at = wire.at?.(head.dir, `refs/heads/${ci}`) ?? tip
  const rejected = at === tip ? null : `${fork} rejected refs/heads/${ci}: it is at ${at === '' ? 'no commit' : at.slice(0, 12)}, not the pushed ${tip.slice(0, 12)}`
  if (outside && rejected === null) moved(root, plan.id, fork, ci, wire)
  return { fork, head, ci, tip, base, rejected }
}

/** A head re-cut from main after its branch was pushed takes the pushed head as a second parent and keeps its own tree. */
function onward(head: Head): Head {
  const shown = `refs/remotes/origin/${head.branch}`
  if (!published(head.dir, head.branch, shown) || ancestor(head.dir, shown, 'HEAD')) return head
  const sha = git(head.dir, [...identity(head.dir), 'commit-tree', ...signing(head.dir), 'HEAD^{tree}', '-p', 'HEAD', '-p', shown,
    '-m', 'carry the earlier push of this branch']).trim()
  git(head.dir, ['update-ref', `refs/heads/${head.branch}`, sha])
  return { ...head, sha }
}

/** `<tip> <head>`: each -next tip made, and the plan HEAD it carries. */
const TIPS = 'next.tips'

function tips(root: string, plan: number): string[][] {
  return (maybe(root, plan, TIPS) ?? '').split('\n').filter((l) => l !== '').map((l) => l.split(' '))
}

/** The plan HEAD a -next tip carries; a -next tip not listed is the plan HEAD itself. */
export function carried(root: string, plan: number, sha: string): string {
  return tips(root, plan).find(([tip]) => tip === sha)?.[1] ?? sha
}

/** A head sent again keeps its tip, so its CI is not restarted. */
function tipOf(root: string, plan: number, head: Head, ci: string, repo: string): string {
  const [known, of] = tips(root, plan).at(-1) ?? []
  if (known !== undefined && of === head.sha) return known
  const tip = quiet(head.dir, ci, config(root, repo))
  put(root, plan, TIPS, `${maybe(root, plan, TIPS) ?? ''}${tip} ${head.sha}\n`)
  return tip
}

/** HEAD plus the rehearsal's `greptile.json`, signed as the host is (an unsigned tip turns the target's PR hygiene red). */
function quiet(dir: string, ci: string, greptile: string): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(git(dir, ['rev-parse', '--absolute-git-dir']).trim(), 'next.index') }
  const index = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, encoding: 'utf8', input: greptile }).trim()
  index(['read-tree', 'HEAD'])
  index(['update-index', '--add', '--cacheinfo', `100644,${blob},greptile.json`])
  const next = `refs/remotes/origin/${ci}`
  const parents = published(dir, ci, next) && !ancestor(dir, next, 'HEAD') ? ['HEAD', next] : ['HEAD']
  return index([...identity(dir), 'commit-tree', ...signing(dir), index(['write-tree']), ...parents.flatMap((p) => ['-p', p]),
    '-m', 'greptile.json: review on request only'])
}

/** A repo GitHub runs no workflow for on a push or pull request: nothing on the fork will ever show a run at the head. */
export function workflows(dir: string): boolean {
  const at = join(dir, '.github/workflows')
  return existsSync(at) && readdirSync(at).filter((f) => /\.ya?ml$/.test(f)).some((f) => triggered(readFileSync(join(at, f), 'utf8')))
}

const TRIGGERS = ['push', 'pull_request']

/** A file that does not parse, or whose `on` has no known shape, counts as one that runs. */
function triggered(text: string): boolean {
  const doc = parseDocument(text)
  return (doc.errors.length === 0 ? events(doc.get('on', true)) : null)?.some((e) => TRIGGERS.includes(e)) ?? true
}

/** Read off the nodes: `toJS` throws on an unresolved alias, too many aliases or a bad merge key, none of them in `errors`. */
function events(on: unknown): string[] | null {
  const nodes: unknown[] | null = isScalar(on) ? [on] : isSeq(on) ? on.items : isMap(on) ? on.items.map((p) => p.key) : null
  const names = nodes?.map((n) => (isScalar(n) ? n.value : null))
  return names?.every((n): n is string => typeof n === 'string') ? names : null
}

/**
 * Our own repo with no workflows, or a part whose fork CI runs once at its parent's step 6, has no CI to wait on, so step 3's checks, run on this
 * host at this head, stand as it. Our own branch lands on `main` from the checkout. An outside repo with no
 * workflows, or none that runs on its branch, comes here too, after its branch is sent.
 */
function checked(db: Db, root: string, plan: PlanRow, repo: string, because?: string): null {
  const passed = passing(db, plan.id, 'gate', 'pre_review')
  const sha = headOf(root, plan.id).sha
  const asm = assembly(db, plan)
  const why = because ?? (asm === null ? `${repo} runs no workflows` : `fork CI runs once on ${asm.branch}, at the parent's step 6`)
  const verdict: Verdict = {
    outcome: passed ? 'pass' : 'refuse',
    defect_class: null,
    origin_kind: passed ? null : 'rail',
    origin_ref: passed ? null : 'ci-green',
    subject_digest: createHash('sha256').update(`${repo}\nlocal\n${sha}`).digest('hex'),
    spans: passed ? [] : ['ci.local'],
    message: `${why}; step 3's checks at ${sha.slice(0, 12)} stand as its CI`,
  }
  put(root, plan.id, BOARD, '[]\n')
  record(db, join(root, 'rails/ci-green'), plan.id, verdict, 0)
  forkGreen(db, plan.id, passed)
  return null
}

/**
 * Every run at the head as the ready gate last read it: the sign-off card lists it, so the card never says
 * green over a workflow still running. Only the runs `mine()` keeps can refuse; the rest are shown, not judged.
 */
export const BOARD = 'ci.json'

/** A workflow the diff does not name is still waited on: the card that follows says what it finished as. */
function others(board: Board[]): string | null {
  const running = board.filter((r) => r.status !== 'completed').map((r) => r.workflow)
  return running.length === 0 ? null : `still running ${running.join(', ')}`
}

export function unfinished(spans: string[]): string | null {
  if (carries(spans, PENDING)) return 'is still running CI'
  return carries(spans, MISSING) ? 'has no run yet' : null
}

export function carries(spans: string[], span: string): boolean {
  return spans.some((one) => one.endsWith(span))
}

/**
 * A wait records nothing -- the gate reads a ci-green verdict only for a head CI has actually judged --
 * and moves nothing: a `rewind` would zero `plans.retries`, and the two-strike escalation `back()`
 * counts is the only way a fork that stays red leaves step 6.
 */
function held(spans: string[], note: string): Outcome {
  return { outcome: 'pass', spans, held: true, note }
}

function onCi(db: Db, plan: number, hold: Outcome): Outcome {
  busy(db, plan, 'waiting on CI', hold.note)
  return hold
}

export function holding(root: string, plan: number, sha: string, spans: string[], waiting: string, window: number,
  key = WAITS): Outcome | null {
  const ticks = waited(root, plan, sha, key)
  return ticks <= window ? held(spans, `${waiting}, tick ${String(ticks)} of ${String(window)}`) : null
}

/** The count is kept against the head it counts for, so a rebuilt branch starts its window over. */
function waited(root: string, plan: number, sha: string, key: string): number {
  const seen = (maybe(root, plan, key) ?? '').split(' ')
  const ticks = seen[0] === sha ? Number(seen[1]) + 1 : 1
  put(root, plan, key, `${sha} ${String(ticks)}`)
  return ticks
}

function commits(dir: string): string[] {
  return git(dir, ['log', '-z', '--format=%B', `${MAIN}..HEAD`]).split('\0').filter((m) => m.trim() !== '')
}

function touched(root: string, plan: number): string[] {
  return parse(diffOf(root, plan)).map((f) => f.path)
}

/**
 * The plan that passed the gates goes onto `main` in the tick that signs it, as a
 * fast-forward of the head the gates signed, and its issue is closed with that sha. A `main` that
 * moved since ready never lands here: step 7 sends it back through
 * `baseMoved` first, so the sha `hooks/pre-push` lets out is the one the rails judged.
 */
export function land(db: Db, root: string, plan: PlanRow, approval: number, wire: Wire = WIRE): Outcome {
  const issue = originIssue(plan)
  if (issue === null) return refuse('plans', `plan ${String(plan.id)} names no issue of ours to land`)
  const src = srcDir(root, plan.id)
  if (!cloned(src)) return refuse('checkout', `plan ${String(plan.id)} has no checkout to land`)
  if (conflicted(src)) return refuse('base:conflict', `plan ${String(plan.id)} has unmerged paths; a conflicted tree is neither committed nor landed`)
  const asm = assembly(db, plan)
  const base = onto(db, root, plan)
  const cut = assembled(src) ?? 'main'
  if (cut !== base) return refuse('base:branch', `plan ${String(plan.id)} was cut from ${cut} but its ticket lands on ${base}; cut it again from ${base}`)
  const head = headOf(root, plan.id)
  const sha = merged(head.dir, head.branch)
  if (sha === null) return refuse('base:stale', `${base} moved under plan ${String(plan.id)} between ready and land; cut it again from ${base}`)
  try {
    wire.send(head.dir, base === 'main' ? 'main' : `main:refs/heads/${base}`)
  } catch (error) {
    fetchMain(head.dir)
    if (ancestor(head.dir, MAIN, sha)) throw error
    return refuse('base:stale', `${base} moved under plan ${String(plan.id)} between fetch and push; cut it again from ${base}`)
  }
  wire.close(homeOf(plan), issue, sha, `landed on ${base} as ${sha}`)
  markPushed(db, plan.id, approval, `https://github.com/${asm?.fork ?? homeOf(plan)}/commit/${sha}`)
  if (plan.lane === 'loupe') wire.install?.()
  return { outcome: 'pass', spans: [], note: `landed ${head.branch} on ${base} as ${sha.slice(0, 12)}` }
}

/**
 * The tree is left on the branch it came in on: every other step reads the checkout as the plan's, not main's.
 * `--ff-only` refuses before it touches a file, so a `main` that moved inside the tick leaves no merge to abort.
 */
function merged(dir: string, branch: string): string | null {
  fetchMain(dir)
  git(dir, ['checkout', '-B', 'main', MAIN])
  if (tried(dir, ['merge', '--ff-only', branch]) === null) {
    git(dir, ['checkout', branch])
    return null
  }
  const sha = git(dir, ['rev-parse', 'main']).trim()
  git(dir, ['checkout', branch])
  return sha
}

/**
 * An internal plan is already on `main`, or a part of an outside plan on its `asm/<parent>`, or a plan on the branch its ask's `Base:` line names; step 8 has
 * no fork branch to send and no pull request to open.
 */
function onMain(db: Db, root: string, plan: PlanRow): Outcome {
  const base = onto(db, root, plan)
  const row = newest(db, plan.id)
  if (row?.state !== 'pushed') return refuse('deliverables', `plan ${String(plan.id)} reached push without landing on ${base}`)
  return { outcome: 'pass', spans: [], note: `on ${base} at ${row.evidence}` }
}

export function push(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): Outcome {
  if (internal(plan)) return onMain(db, root, plan)
  const target = pushTarget(db, plan)
  if (target === null) return refuse('targets', `plan ${String(plan.id)} has no target row`)
  if (!cloned(srcDir(root, plan.id))) return refuse('checkout', `plan ${String(plan.id)} has no checkout to send`)
  const head = headOf(root, plan.id)
  const signed = signedAt(root, plan.id, head.sha)
  const approval = signedHead(db, plan.id, headDigest(signed))
  if (approval === null) return refuse('approvals', `no ceo approval row for ${head.branch} at ${head.sha.slice(0, 12)}`)
  const cold = unproven(db, plan.id)
  if (cold !== null) return refuse(cold, `${cold} left no passing verdict on plan ${String(plan.id)}`)
  const late = overlap(root, plan.id, head.dir, signed)
  if (late !== null) return refuse('their_work', late)
  const rules = profile(root, target.repo)
  const text = maybe(root, plan.id, 'pr.md') ?? prBody(target.issue_no, root, plan.id, rules)
  const named = prTitle(root, plan.id)
  const open = opened(db, plan.id)
  if (open === null && !onFork(head.dir, head.branch)) {
    squash(root, plan.id, rules, prMessage(named, text, rules))
    bind(root, plan.id, headOf(root, plan.id).sha, signed)
  }
  const checks = [...CHECKS, size(target.repo), prosed(named, text), titled, merging(target.repo, wire.merged), ...(wire.card ?? [])]
  const card = waiting(db, root, plan.id, signed, target, checks)
  if (card !== null) return card
  wire.send(head.dir, head.branch)
  retire(`${FORK}/${repoName(target.repo)}`, rehearsed(root, plan.id, head.branch), wire)
  if (open !== null) {
    const md = maybe(root, plan.id, 'pr.md')
    if (md !== null) wire.describe?.(target.repo, prNumber(open), md)
    markPushed(db, plan.id, approval, open)
    return { outcome: 'pass', spans: [], note: `pushed ${head.branch} onto ${open}` }
  }
  const body = maybe(root, plan.id, 'pr.md') === null
    ? put(root, plan.id, 'pr.md', text)
    : join(planDir(root, plan.id), 'pr.md')
  const url = wire.open(target.repo, `caliperforge:${head.branch}`, named, body)
  markPushed(db, plan.id, approval, url)
  return { outcome: 'pass', spans: [], note: `pushed ${head.branch} as ${url}` }
}

export { opened, prBody }

/** The ready gate already consumed fork CI and the counterparty bot; push reads its rows, never reruns them. */
function unproven(db: Db, plan: number): string | null {
  return ['ci-green', 'ready'].find((rail) => !passing(db, plan, 'rail_id', rail)) ?? null
}

/** Read into `FETCH_HEAD`: moving `MAIN` would change an approved card's conventions row. `^HEAD` leaves out main commits the branch merged. */
function overlap(root: string, plan: number, dir: string, signed: string): string | null {
  git(dir, ['fetch', '--no-tags', 'upstream', 'HEAD'])
  const main = git(dir, ['rev-parse', 'FETCH_HEAD']).trim()
  const from = carded(root, plan, signed)
  const files = touched(root, plan)
  const late = files.length === 0 ? ''
    : git(dir, ['log', '--format=%h %s', main, `^${from ?? git(dir, ['merge-base', 'HEAD', MAIN]).trim()}`, '^HEAD', '--', ...files]).trim()
  if (late !== '') return `upstream main moved on our files since the card: ${late.split('\n').join('; ')}`
  if (from === null) put(root, plan, THEIRS, `${signed} ${main}\n`)
  return null
}

/** The upstream main sha saved when this signed head's card was first filed. */
function carded(root: string, plan: number, signed: string): string | null {
  const [at, main] = (maybe(root, plan, THEIRS) ?? '').trim().split(' ')
  return at === signed && main !== undefined ? main : null
}

/** The digest on the card must name bytes that are in the branch, so the plan's work lands before it is shown. */
export function headOf(root: string, plan: number): Head {
  const dir = srcDir(root, plan)
  if (!cloned(dir)) throw new Error(`plan ${String(plan)} has no checkout at ${dir}`)
  commitWork(dir, maybe(root, plan, COMMIT))
  return {
    dir,
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    sha: git(dir, ['rev-parse', 'HEAD']).trim(),
  }
}

function commitWork(dir: string, message: string | null): void {
  git(dir, ['add', '-A', '--', '.'])
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return
  git(dir, ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'commit', '-qm', message ?? git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()])
}

export function title(root: string, plan: number): string {
  return titleOf(root, plan) ?? `plan ${String(plan)}`
}

function titled(...[, root, plan, target]: Parameters<Check>): Row {
  const lines = (maybe(root, plan, 'ask.md') ?? '').split('\n')
  const theirs = /^#{1,3}\s+(.*)$/m.exec(lines.slice(lines.findIndex((l) => l.includes(CARD)) + 1).join('\n'))?.[1]?.trim()
  const mine = prTitle(root, plan)
  const no = `#${String(target.issue_no)}'s title`
  return mine === theirs ? { check: 'title', ok: false, says: `"${mine}" is ${no}` } : { check: 'title', ok: true, says: `not ${no}` }
}

/** The brief's What and Why lines, the two things a maintainer reads first. */
export function said(brief: string, keys = ['**What:**', '**Why:**']): string[] {
  return keys.flatMap((key) => {
    const line = brief.split('\n').find((l) => l.startsWith(key))?.slice(key.length).trim()
    return line === undefined || line === '' ? [] : [line]
  })
}

/**
 * A stranger's branch first goes out as one commit, signed as whoever this host's git says it is,
 * with the brief's title as its subject. The rounds' commits and any merge of
 * their main fold into it; a branch already in that shape is left alone, so a held CI keeps its head.
 */
export function squash(root: string, plan: number, rules: Profile | null = null, message = messageOf(root, plan, rules)): string {
  const dir = srcDir(root, plan)
  git(dir, ['add', '-A', '--', '.'])
  const base = git(dir, ['merge-base', 'HEAD', MAIN]).trim()
  const count = Number(git(dir, ['rev-list', '--count', `${base}..HEAD`]).trim())
  const staged = git(dir, ['diff', '--cached', '--name-only']).trim() !== ''
  if (!staged && count === 1 && git(dir, ['log', '-1', '--format=%B']).trim() === message) return base
  git(dir, ['reset', '--soft', base])
  sign(dir, message)
  return base
}

function unfolded(dir: string, base: string, message: string): string | null {
  const head = git(dir, ['rev-parse', 'HEAD']).trim()
  if (head === base) return null
  const parent = git(dir, ['rev-parse', 'HEAD^']).trim()
  if (parent === base && git(dir, ['log', '-1', '--format=%B']).trim() === message) return null
  return `${head.slice(0, 12)} is not one commit over ${base.slice(0, 12)} with the brief's message; fold it again`
}

function onFork(dir: string, branch: string): boolean {
  return git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim() !== ''
}

function ancestor(dir: string, older: string, newer: string): boolean {
  return tried(dir, ['merge-base', '--is-ancestor', older, newer]) !== null
}

/** The rehearsal branch saved for the plan, else `<branch>-next`. */
function rehearsed(root: string, plan: number, branch: string): string {
  return maybe(root, plan, REHEARSED) ?? `${branch}${NEXT}`
}

/** Read without `headOf`, which commits the plan's work. */
export function rehearsalBranch(root: string, plan: number): string {
  return rehearsed(root, plan, git(srcDir(root, plan), ['rev-parse', '--abbrev-ref', 'HEAD']).trim())
}

/**
 * Once our fork holds the branch it only moves forward -- no force-push, ever. The rounds'
 * commits since the head our fork shows fold into one signed follow-up commit on top of it,
 * with a main merged since that head as its second parent.
 */
export function follow(root: string, plan: number, message: string): string {
  const dir = srcDir(root, plan)
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const shown = `refs/remotes/origin/${branch}`
  git(dir, ['add', '-A', '--', '.'])
  if (!published(dir, branch, shown)) {
    sign(dir, message)
    return git(dir, ['merge-base', 'HEAD', MAIN]).trim()
  }
  const tip = git(dir, ['rev-parse', shown]).trim()
  const count = Number(git(dir, ['rev-list', '--count', `${tip}..HEAD`]).trim())
  const staged = git(dir, ['diff', '--cached', '--name-only']).trim() !== ''
  const same = count === 0 || (git(dir, ['rev-parse', 'HEAD^']).trim() === tip && git(dir, ['log', '-1', '--format=%B']).trim() === message)
  if (!staged && same && ancestor(dir, tip, 'HEAD')) return tip
  const base = git(dir, ['merge-base', 'HEAD', MAIN]).trim()
  if (!ancestor(dir, base, tip)) {
    const sha = git(dir, [...identity(dir), 'commit-tree', git(dir, ['write-tree']).trim(), '-p', tip, '-p', base, '-m', message]).trim()
    git(dir, ['update-ref', `refs/heads/${branch}`, sha])
    return tip
  }
  git(dir, ['reset', '--soft', tip])
  sign(dir, message)
  return tip
}

/** Whether we know the head the pull request shows; not knowing it, nothing already committed is folded. */
function published(dir: string, branch: string, shown: string): boolean {
  return tried(dir, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${shown}`]) !== null
}

/** A commit as the host's git identity, signed where the host signs; nothing staged is no commit. */
function sign(dir: string, message: string): void {
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return
  execFileSync('git', [...identity(dir), 'commit', '-q', '-m', message],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

/** Subject and body with no upstream number the profile's `issue_ref` does not allow: the ci-green rail refuses a branch whose commits name one. */
export function messageOf(root: string, plan: number, rules: Profile | null = null): string {
  const body = said(maybe(root, plan, 'issue.md') ?? '').map((l) => clean(l, rules)).join('\n\n')
  const trailer = rules?.ai_trailer === true ? rules.trailer ?? '' : ''
  return [subjectOf(title(root, plan), rules), body, trailer].filter((p) => p !== '').join('\n\n')
}

export const COMMIT = 'commit.msg'

/** `<signed> <main sha>`: the signed head a card was filed for, and upstream main at that moment. */
const THEIRS = 'theirs.main'

/** `Closes` stays owner-qualified: ci-green refuses a bare number (`rails/ci-green/index.ts:123`). */
export function commitMessage(root: string, plan: PlanRow): string | null {
  const ref = originRef(plan)
  return ref === null ? null : `${messageOf(root, plan.id)}\n\nCloses ${ref.repo}#${String(ref.no)}\nPlan ${String(plan.id)}`
}

/** The host's own identity where it has one; a bare runner (CI, a test) commits as the machine. */
function identity(dir: string): string[] {
  return tried(dir, ['config', 'user.email']) === null ? ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge'] : []
}

/** `commit-tree` ignores `commit.gpgsign` and signs only when given `-S` (git-commit-tree(1)). */
function signing(dir: string): string[] {
  return git(dir, ['config', '--type=bool', '--default=false', 'commit.gpgsign']).trim() === 'true' ? ['-S'] : []
}

function refuse(span: string, note: string): Outcome {
  return { outcome: 'refuse', spans: [span], note }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
