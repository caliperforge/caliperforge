import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { closeIssue, openPr } from '../cli/gh.ts'
import { ciGreen, MISSING, PENDING, shell, type Gh } from '../rails/ci-green/index.ts'
import { parse } from '../rails/diff.ts'
import { record } from '../rails/record.ts'
import { headDigest, signedHead } from '../store/approvals.ts'
import { forkGreen } from '../store/deliverables.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, type PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { cloned, conflicted, diffOf, fetchMain, FORK, get, MAIN, maybe, put, repoName, SELF, srcDir, titleOf } from './workspace.ts'

interface Head { dir: string; branch: string; sha: string }

/** The transport, named so a test can watch it: R4 says the send itself is never the seat's to make. */
export interface Wire {
  send: (dir: string, branch: string) => void
  open: (repo: string, head: string, title: string, bodyFile: string) => string
  close: (repo: string, no: number, sha: string) => void
  runs: Gh
}

const WIRE: Wire = {
  send: (dir, branch) => void git(dir, ['push', '--set-upstream', 'origin', branch]),
  open: openPr,
  close: closeIssue,
  runs: shell,
}

/** Ticks a head is given to reach a finished run; past them an unfinished CI is judged as it stands. */
const APPEARS = 10

const WAITS = 'ci.waits'

/**
 * Step 6 before the gate: the branch goes to our fork -- no pull request, and the rail reads the
 * branch's own commit messages for an upstream number -- and `rails/ci-green` judges the runs at
 * that head. GitHub has no run at a head the moment the push returns, so a head with no run yet
 * waits exactly as a run still going does, and both waits share one window: past `APPEARS` ticks
 * the spans are recorded as the refusal they are, so a CI that never greens still reaches `back()`.
 */
export function forkCi(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire = WIRE): Outcome | null {
  const head = headOf(root, plan.id)
  const fork = `${FORK}/${repoName(repo)}`
  wire.send(head.dir, head.branch)
  const verdict = ciGreen({ fork, branch: head.branch, sha: head.sha },
    { body: '', commits: commits(head.dir) }, touched(root, plan.id), wire.runs)
  const waiting = unfinished(verdict.spans)
  if (waiting !== null) {
    const ticks = waited(root, plan.id, head.sha)
    const at = `${fork}@${head.sha.slice(0, 12)}`
    if (ticks <= APPEARS) return held(verdict.spans, `${at} ${waiting}, tick ${String(ticks)} of ${String(APPEARS)}`)
  }
  record(db, join(root, 'rails/ci-green'), plan.id, verdict, 0)
  forkGreen(db, plan.id, verdict.outcome === 'pass')
  return null
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
  wire.close(SELF, issue, sha)
  pushed(db, plan.id, approval, `https://github.com/${SELF}/commit/${sha}`)
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
  const body = put(root, plan.id, 'pr.md', prBody(target.issue_no, root, plan.id))
  wire.send(head.dir, head.branch)
  const url = wire.open(target.repo, `caliperforge:${head.branch}`, title(root, plan.id), body)
  pushed(db, plan.id, approval, url)
  return { outcome: 'pass', spans: [], note: `pushed ${head.branch} as ${url}` }
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

/** Tight: a description that summarises the diff is a refusal, so the body names the issue and its ids. */
export function prBody(no: number, root: string, plan: number): string {
  const ids = [...get(root, plan, 'issue.md').matchAll(/^\s*[-*]\s*\**(D\d+)\**\s*(.*)$/gm)]
    .map((m) => `- ${String(m[1])} ${(m[2] ?? '').trim()}`)
  return [`Closes #${String(no)}`, '', ...ids].slice(0, 20).join('\n').concat('\n')
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
