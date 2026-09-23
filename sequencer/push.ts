import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { closeIssue, commentIssue, fileIssue, openPr, rehearse, unrehearse } from '../cli/gh.ts'
import { judge, MISSING, PENDING, shell, type Board, type Gh } from '../rails/ci-green/index.ts'
import { parse } from '../rails/diff.ts'
import { record } from '../rails/record.ts'
import { headDigest, signedHead } from '../store/approvals.ts'
import { forkGreen } from '../store/deliverables.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, type PlanRow } from '../store/plans.ts'
import { red } from './failures.ts'
import type { Outcome } from './kind.ts'
import { cloned, conflicted, diffOf, fetchMain, FORK, get, MAIN, maybe, planDir, put, repoName, srcDir, titleOf } from './workspace.ts'
import { homeOf } from './home.ts'

interface Head { dir: string; branch: string; sha: string }

/** The transport, named so a test can watch it: R4 says the send itself is never the seat's to make. */
export interface Wire {
  send: (dir: string, branch: string) => void
  open: (repo: string, head: string, title: string, bodyFile: string) => string
  close: (repo: string, no: number, sha: string) => void
  runs: Gh
  rehearse?: (fork: string, branch: string) => void
  unrehearse?: (fork: string, branch: string) => void
  file: (repo: string, title: string, body: string, labels: string[]) => string
  comment: (repo: string, no: number, body: string) => void
}

export const WIRE: Wire = {
  send: (dir, branch) => void git(dir, ['push', '--set-upstream', 'origin', branch]),
  open: openPr,
  close: closeIssue,
  file: fileIssue,
  comment: commentIssue,
  runs: shell,
  rehearse,
  unrehearse,
}

/**
 * Once the pull request is open, CI runs on this branch beside it: pushing the real branch would put
 * an unsigned-off round on the maintainer's screen before the CEO has seen it.
 */
const NEXT = '-next'

/** Ticks a head is given to reach a finished run; past them an unfinished CI is judged as it stands. */
const APPEARS = 10

const WAITS = 'ci.waits'

/**
 * Step 6 before the gate: the branch goes to our fork -- no pull request, and the rail reads the
 * branch's own commit messages for an upstream number -- and `rails/ci-green` judges the runs at
 * that head. GitHub has no run at a head the moment the push returns, so a head with no run yet
 * waits exactly as a run still going does, and both waits share one window: past `APPEARS` ticks
 * the spans are recorded as the refusal they are, so a CI that never greens still reaches `back()`.
 * A red run goes to the builder, not a reviewer: their CI is the only test an outside build gets.
 */
export function forkCi(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire = WIRE): Outcome | null {
  const open = !internal(plan) && opened(db, plan.id) !== null
  const fork = `${FORK}/${repoName(repo)}`
  if (!internal(plan)) (open ? follow : squash)(root, plan.id)
  if (!internal(plan) && !open) renamed(srcDir(root, plan.id), fork, wire)
  const head = headOf(root, plan.id)
  const ci = open ? `${head.branch}${NEXT}` : head.branch
  wire.send(head.dir, open ? `HEAD:refs/heads/${ci}` : head.branch)
  if (!internal(plan)) wire.rehearse?.(fork, ci)
  const { verdict, board } = judge({ fork, branch: ci, sha: head.sha },
    { body: '', commits: commits(head.dir) }, touched(root, plan.id), wire.runs)
  put(root, plan.id, BOARD, `${JSON.stringify(board)}\n`)
  const waiting = unfinished(verdict.spans) ?? others(board)
  if (waiting !== null) {
    const ticks = waited(root, plan.id, head.sha)
    const at = `${fork}@${head.sha.slice(0, 12)}`
    if (ticks <= APPEARS) return held(verdict.spans, `${at} ${waiting}, tick ${String(ticks)} of ${String(APPEARS)}`)
  }
  record(db, join(root, 'rails/ci-green'), plan.id, verdict, 0)
  forkGreen(db, plan.id, verdict.outcome === 'pass')
  const failed = verdict.outcome === 'refuse' ? red(fork, verdict.spans, wire.runs) : null
  if (failed === null) return null
  return { outcome: 'refuse', spans: failed.spans, message: failed.log, to: 2,
    note: `their CI is red on ${fork}@${head.sha.slice(0, 12)}; back to the builder with the failed log` }
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

function unfinished(spans: string[]): string | null {
  if (carries(spans, PENDING)) return 'is still running CI'
  return carries(spans, MISSING) ? 'has no run yet' : null
}

function carries(spans: string[], span: string): boolean {
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

/** The count is kept against the head it counts for, so a rebuilt branch starts its window over. */
function waited(root: string, plan: number, sha: string): number {
  const seen = (maybe(root, plan, WAITS) ?? '').split(' ')
  const ticks = seen[0] === sha ? Number(seen[1]) + 1 : 1
  put(root, plan, WAITS, `${sha} ${String(ticks)}`)
  return ticks
}

function commits(dir: string): string[] {
  return git(dir, ['log', '-z', '--format=%B', `${MAIN}..HEAD`]).split('\0').filter((m) => m.trim() !== '')
}

function touched(root: string, plan: number): string[] {
  return parse(diffOf(root, plan)).map((f) => f.path)
}

/**
 * #35 rule 1: the plan that passed the gates goes onto `main` in the tick that signs it, as a
 * fast-forward of the head the gates signed, and its issue is closed with that sha. A `main` that
 * moved since ready is #35 rule 3's case and never lands here: step 7 sends it back through
 * `baseMoved` first, so the sha `hooks/pre-push` lets out is the one the rails judged.
 */
export function land(db: Db, root: string, plan: PlanRow, approval: number, wire: Wire = WIRE): Outcome {
  const issue = originIssue(plan)
  if (issue === null) return refuse('plans', `plan ${String(plan.id)} names no issue of ours to land`)
  const src = srcDir(root, plan.id)
  if (!cloned(src)) return refuse('checkout', `plan ${String(plan.id)} has no checkout to land`)
  if (conflicted(src)) return refuse('base:conflict', `plan ${String(plan.id)} has unmerged paths; a conflicted tree is neither committed nor landed`)
  const head = headOf(root, plan.id)
  const sha = merged(head.dir, head.branch)
  if (sha === null) return refuse('base:stale', `main moved under plan ${String(plan.id)} between ready and land; cut it again from main`)
  wire.send(head.dir, 'main')
  wire.close(homeOf(plan), issue, sha)
  pushed(db, plan.id, approval, `https://github.com/${homeOf(plan)}/commit/${sha}`)
  return { outcome: 'pass', spans: [], note: `landed ${head.branch} on main as ${sha.slice(0, 12)}` }
}

/**
 * The tree is left on the branch it came in on: every other step reads the checkout as the plan's, not main's.
 * `--ff-only` refuses before it touches a file, so a `main` that moved inside the tick leaves no merge to abort.
 */
function merged(dir: string, branch: string): string | null {
  fetchMain(dir)
  git(dir, ['checkout', '-B', 'main', MAIN])
  try {
    git(dir, ['merge', '--ff-only', branch])
  } catch {
    git(dir, ['checkout', branch])
    return null
  }
  const sha = git(dir, ['rev-parse', 'main']).trim()
  git(dir, ['checkout', branch])
  return sha
}

/** An internal plan is already on `main`; step 8 has no fork branch to send and no pull request to open. */
function onMain(db: Db, plan: PlanRow): Outcome {
  const row = db.prepare("SELECT state, evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1")
    .get(plan.id) as { state: string; evidence: string } | undefined
  if (row?.state !== 'pushed') return refuse('deliverables', `plan ${String(plan.id)} reached push without landing on main`)
  return { outcome: 'pass', spans: [], note: `on main at ${row.evidence}` }
}

export function push(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): Outcome {
  if (internal(plan)) return onMain(db, plan)
  const target = subject(db, plan)
  if (target === null) return refuse('targets', `plan ${String(plan.id)} has no target row`)
  if (!cloned(srcDir(root, plan.id))) return refuse('checkout', `plan ${String(plan.id)} has no checkout to send`)
  const head = headOf(root, plan.id)
  const approval = signedHead(db, plan.id, headDigest(head.sha))
  if (approval === null) return refuse('approvals', `no ceo approval row for ${head.branch} at ${head.sha.slice(0, 12)}`)
  const cold = unproven(db, plan.id)
  if (cold !== null) return refuse(cold, `${cold} left no passing verdict on plan ${String(plan.id)}`)
  const open = opened(db, plan.id)
  wire.send(head.dir, head.branch)
  wire.unrehearse?.(`${FORK}/${repoName(target.repo)}`, open === null ? head.branch : `${head.branch}${NEXT}`)
  if (open !== null) {
    pushed(db, plan.id, approval, open)
    return { outcome: 'pass', spans: [], note: `pushed ${head.branch} onto ${open}` }
  }
  const body = maybe(root, plan.id, 'pr.md') === null
    ? put(root, plan.id, 'pr.md', prBody(target.issue_no, root, plan.id))
    : join(planDir(root, plan.id), 'pr.md')
  const url = wire.open(target.repo, `caliperforge:${head.branch}`, title(root, plan.id), body)
  pushed(db, plan.id, approval, url)
  return { outcome: 'pass', spans: [], note: `pushed ${head.branch} as ${url}` }
}

/** The pull request this plan already opened, if it did: the row step 8 stamped carries its url. */
export function opened(db: Db, plan: number): string | null {
  const row = db.prepare(`SELECT evidence FROM deliverables WHERE plan_id = ? AND state = 'pushed'
    AND evidence GLOB 'https://*/pull/*' ORDER BY id DESC LIMIT 1`).get(plan) as { evidence: string } | undefined
  return row?.evidence ?? null
}

/** The ready gate already consumed fork CI and the counterparty bot; push reads its rows, never reruns them. */
function unproven(db: Db, plan: number): string | null {
  for (const [name, sql] of GATES) {
    const row = db.prepare(sql).get(plan) as { outcome: string } | undefined
    if (row?.outcome !== 'pass') return name
  }
  return null
}

const GATES: [string, string][] = [
  ['ci-green', "SELECT outcome FROM verdicts WHERE plan = ? AND rail_id = 'ci-green' ORDER BY id DESC LIMIT 1"],
  ['ready', "SELECT outcome FROM verdicts WHERE plan = ? AND gate = 'ready' AND rail_id = 'ready' ORDER BY id DESC LIMIT 1"],
]

function pushed(db: Db, plan: number, approval: number, url: string): void {
  db.prepare(`UPDATE deliverables SET state = 'pushed', approval_id = ?, evidence = ?
    WHERE id = (SELECT id FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1)`).run(approval, url, plan)
}

/** The digest on the card must name bytes that are in the branch, so the plan's work lands before it is shown. */
export function headOf(root: string, plan: number): Head {
  const dir = srcDir(root, plan)
  if (!cloned(dir)) throw new Error(`plan ${String(plan)} has no checkout at ${dir}`)
  commitWork(dir)
  return {
    dir,
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    sha: git(dir, ['rev-parse', 'HEAD']).trim(),
  }
}

function commitWork(dir: string): void {
  git(dir, ['add', '-A', '--', '.'])
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return
  git(dir, ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'commit', '-qm', git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()])
}

function title(root: string, plan: number): string {
  return titleOf(root, plan) ?? `plan ${String(plan)}`
}

const TEST = /(^|\/)(tests?|spec|__tests__)\/|[._](test|spec)\.|Tests?\./

/**
 * Used when the card set no body. Their shape, not ours: it addresses the issue rather than closing
 * it, since one item of a maintainer's list is not the list.
 */
export function prBody(no: number, root: string, plan: number): string {
  const brief = get(root, plan, 'issue.md')
  const tests = parse(diffOf(root, plan)).map((f) => f.path).filter((p) => TEST.test(p))
  return [`Addresses #${String(no)}.`, '', '## Summary', '', ...said(brief).map((l) => `- ${l}`), '',
    '## Test Plan', '', ...tests.map((t) => `- \`${t}\``), '- CI green on our fork at this head.', ''].join('\n')
}

/** The brief's What and Why lines, the two things a maintainer reads first. */
function said(brief: string): string[] {
  return ['**What:**', '**Why:**'].flatMap((key) => {
    const line = brief.split('\n').find((l) => l.startsWith(key))?.slice(key.length).trim()
    return line === undefined || line === '' ? [] : [line]
  })
}

/**
 * A stranger's branch goes out as one commit, signed as whoever this host's git says it is -- the
 * CEO, on his Mac -- with the brief's title as its subject. The rounds' commits and any merge of
 * their main fold into it; a branch already in that shape is left alone, so a held CI keeps its head.
 */
export function squash(root: string, plan: number): void {
  const dir = srcDir(root, plan)
  const message = messageOf(root, plan)
  git(dir, ['add', '-A', '--', '.'])
  const base = git(dir, ['merge-base', 'HEAD', MAIN]).trim()
  const count = Number(git(dir, ['rev-list', '--count', `${base}..HEAD`]).trim())
  const staged = git(dir, ['diff', '--cached', '--name-only']).trim() !== ''
  if (!staged && count === 1 && git(dir, ['log', '-1', '--format=%B']).trim() === message) return
  git(dir, ['reset', '--soft', base])
  sign(dir, message)
}

/**
 * A round after the first on a branch no pull request shows yet. Its squash cannot fast-forward the commit
 * our fork already holds, and nothing is force-pushed, ever: the round goes out under the next attempt's
 * name and the old rehearsal closes without a word. The pull request opens from whichever branch the last
 * round used.
 */
function renamed(dir: string, fork: string, wire: Wire): void {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (!onFork(dir, branch) || carried(dir, branch)) return
  git(dir, ['branch', '-m', nextFree(dir, branch)])
  wire.unrehearse?.(fork, branch)
}

function onFork(dir: string, branch: string): boolean {
  return git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim() !== ''
}

/** Whether HEAD carries the commit our fork holds for the branch, so a plain push only moves it forward. */
function carried(dir: string, branch: string): boolean {
  try {
    git(dir, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    git(dir, ['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, 'HEAD'])
    return true
  } catch {
    return false
  }
}

function nextFree(dir: string, branch: string): string {
  const hit = /^(.*)-a(\d+)$/.exec(branch)
  const stem = hit?.[1] ?? branch
  let n = hit === null ? 2 : Number(hit[2]) + 1
  while (onFork(dir, `${stem}-a${String(n)}`)) n += 1
  return `${stem}-a${String(n)}`
}

/**
 * Once the pull request is open its branch only moves forward -- no force-push, ever. The rounds'
 * commits since the head the pull request shows fold into one signed follow-up commit on top of it.
 */
export function follow(root: string, plan: number): void {
  const dir = srcDir(root, plan)
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const shown = `refs/remotes/origin/${branch}`
  const message = `${kindOf(title(root, plan))}: address review`
  git(dir, ['add', '-A', '--', '.'])
  if (!published(dir, branch, shown)) {
    sign(dir, message)
    return
  }
  const count = Number(git(dir, ['rev-list', '--count', `${shown}..HEAD`]).trim())
  const staged = git(dir, ['diff', '--cached', '--name-only']).trim() !== ''
  if (!staged && (count === 0 || (count === 1 && git(dir, ['log', '-1', '--format=%B']).trim() === message))) return
  git(dir, ['reset', '--soft', shown])
  sign(dir, message)
}

/** Whether we know the head the pull request shows; not knowing it, nothing already committed is folded. */
function published(dir: string, branch: string, shown: string): boolean {
  try {
    git(dir, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${shown}`])
    return true
  } catch {
    return false
  }
}

/** A commit as the host's git identity, signed where the host signs; nothing staged is no commit. */
function sign(dir: string, message: string): void {
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return
  execFileSync('git', [...identity(dir), 'commit', '-q', '-m', message],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

/** The conventional-commit type and scope of the pull request's title, for its follow-up commits. */
function kindOf(title: string): string {
  return /^([a-z]+(?:\([^)]*\))?)!?:/.exec(title)?.[1] ?? 'fix'
}

/** Subject and body with no upstream number: the ci-green rail refuses a branch whose commits name one. */
function messageOf(root: string, plan: number): string {
  const clean = (s: string): string => s.replace(/#\d+/g, '').replace(/\s+/g, ' ').trim()
  const subject = clean(title(root, plan))
  const body = said(maybe(root, plan, 'issue.md') ?? '').map(clean).join('\n\n')
  return body === '' ? subject : `${subject}\n\n${body}`
}

/** The host's own identity where it has one; a bare runner (CI, a test) commits as the machine. */
function identity(dir: string): string[] {
  try {
    git(dir, ['config', 'user.email'])
    return []
  } catch {
    return ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge']
  }
}

function refuse(span: string, note: string): Outcome {
  return { outcome: 'refuse', spans: [span], note }
}

/** The stranger's repository the pull request is opened on and the issue it closes. */
function subject(db: Db, plan: PlanRow): { repo: string; issue_no: number } | null {
  return (db.prepare('SELECT repo, issue_no FROM targets WHERE id = ?').get(plan.target_id) ?? null) as
    { repo: string; issue_no: number } | null
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
