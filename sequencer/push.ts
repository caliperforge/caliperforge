import { execFileSync } from 'node:child_process'
import { closeIssue, openPr } from '../cli/gh.ts'
import { gates, headDigest, signedHead } from '../store/approvals.ts'
import type { Db } from '../store/index.ts'
import { internal, originIssue, type PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { cloned, fetchMain, get, MAIN, put, SELF, srcDir, titleOf } from './workspace.ts'

interface Head { dir: string; branch: string; sha: string }

/** The transport, named so a test can watch it: R4 says the send itself is never the seat's to make. */
export interface Wire {
  send: (dir: string, branch: string) => void
  open: (repo: string, head: string, title: string, bodyFile: string) => string
  close: (repo: string, no: number, sha: string) => void
}

const WIRE: Wire = {
  send: (dir, branch) => void git(dir, ['push', '--set-upstream', 'origin', branch]),
  open: openPr,
  close: closeIssue,
}

/**
 * #35 rule 1: the plan that passed the gates goes onto `main` in the tick that signs it -- a
 * fast-forward while the branch still sits on main's head, a merge commit once it does not -- and
 * its issue is closed with that sha. A merge commit is a second name for bytes the gates already
 * proved, so the gates sign it too and `hooks/pre-push` lets `main` out on the same clause.
 */
export function land(db: Db, root: string, plan: PlanRow, approval: number, wire: Wire = WIRE): Outcome {
  const issue = originIssue(plan)
  if (issue === null) return refuse('plans', `plan ${String(plan.id)} names no issue of ours to land`)
  if (!cloned(srcDir(root, plan.id))) return refuse('checkout', `plan ${String(plan.id)} has no checkout to land`)
  const head = headOf(root, plan.id)
  const sha = merged(head.dir, head.branch)
  if (sha !== head.sha) gates(db, plan.id, headDigest(sha))
  wire.send(head.dir, 'main')
  wire.close(SELF, issue, sha)
  pushed(db, plan.id, approval, `https://github.com/${SELF}/commit/${sha}`)
  return { outcome: 'pass', spans: [], note: `landed ${head.branch} on main as ${sha.slice(0, 12)}` }
}

/** The tree is left on the branch it came in on: every other step reads the checkout as the plan's, not main's. */
function merged(dir: string, branch: string): string {
  fetchMain(dir)
  git(dir, ['checkout', '-B', 'main', MAIN])
  git(dir, ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'merge', '--ff', '--no-edit', '-m', `land ${branch}`, branch])
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
