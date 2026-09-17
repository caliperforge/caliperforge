import { execFileSync } from 'node:child_process'
import { openPr } from '../cli/gh.ts'
import { approvalOf, headDigest } from '../store/approvals.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { cloned, get, put, srcDir } from './workspace.ts'

interface Head { dir: string; branch: string; sha: string }

/** The transport, named so a test can watch it: R4 says the send itself is never the seat's to make. */
export interface Wire {
  send: (dir: string, branch: string) => void
  open: (repo: string, head: string, title: string, bodyFile: string) => string
}

const WIRE: Wire = {
  send: (dir, branch) => void git(dir, ['push', '--set-upstream', 'origin', branch]),
  open: openPr,
}

export function push(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): Outcome {
  const target = targetOf(db, plan)
  if (target === null) return refuse('targets', `plan ${String(plan.id)} has no target row`)
  if (!cloned(srcDir(root, plan.id))) return refuse('checkout', `plan ${String(plan.id)} has no checkout to send`)
  const head = headOf(root, plan.id)
  const approval = approvalOf(db, 'plan', plan.id, headDigest(head.sha))
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
  land(dir)
  return {
    dir,
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    sha: git(dir, ['rev-parse', 'HEAD']).trim(),
  }
}

function land(dir: string): void {
  git(dir, ['add', '-A', '--', '.'])
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return
  git(dir, ['-c', 'user.email=cf@caliperforge.dev', '-c', 'user.name=caliperforge',
    'commit', '-qm', git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()])
}

function title(root: string, plan: number): string {
  return /^#\s+(.*)$/m.exec(get(root, plan, 'issue.md'))?.[1]?.trim() ?? `plan ${String(plan)}`
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

function targetOf(db: Db, plan: PlanRow): { repo: string; issue_no: number } | null {
  return (db.prepare('SELECT repo, issue_no FROM targets WHERE id = ?').get(plan.target_id) ?? null) as
    { repo: string; issue_no: number } | null
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
