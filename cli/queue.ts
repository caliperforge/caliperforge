import { z } from 'zod'
import { put } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { claimed, implemented, issue as readIssue, lastMerger } from './gh.ts'

const Account = z.object({ id: z.int(), measured_at: z.string(), pulse: z.enum(['warm', 'cold']) })

const URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/

export interface Added {
  target: number
  plan: number | null
  state: 'ready' | 'parked' | 'refused'
  why: string
}

export function parse(repo: string, url: string): number {
  const hit = URL.exec(url)
  if (hit === null) throw new Error(`"${url}" is not a github issue url`)
  if (hit[1] !== repo) throw new Error(`issue url names ${String(hit[1])}, not ${repo}`)
  return Number(hit[2])
}

export function account(db: Db, repo: string, today: string): z.infer<typeof Account> {
  const row = db.prepare('SELECT id, measured_at, pulse FROM accounts WHERE repo = ? ORDER BY measured_at DESC LIMIT 1').get(repo)
  if (row === undefined) throw new Error(`no accounts row for ${repo}; measure it before queueing`)
  const parsed = Account.parse(row)
  const days = Math.floor((Date.parse(today) - Date.parse(parsed.measured_at.slice(0, 10))) / 86400000)
  if (days > 30) throw new Error(`${repo} was measured ${String(days)} days ago; re-measure before queueing`)
  return parsed
}

export function add(db: Db, root: string, repo: string, url: string, pipe: string, today: string): Added {
  const no = parse(repo, url)
  const pulse = account(db, repo, today)
  const row = readIssue(repo, no)
  const merger = lastMerger(repo)
  const why = claimed(row) ?? implemented(repo, row) ?? (merger === null ? `${repo} has no named merger` : null)
  const state = why !== null ? 'refused' : pulse.pulse === 'cold' ? 'parked' : 'ready'
  const target = upsert(db, pulse, repo, no, merger ?? '', state, url)
  if (why !== null) return { target, plan: null, state, why }
  const plan = planFor(db, pipe, target)
  put(root, plan, 'issue.md', `# ${row.title}\n\n${row.body}\n`)
  return { target, plan, state, why: state === 'parked' ? `${repo} pulse is cold; parked` : `${repo}#${String(no)} queued` }
}

function upsert(db: Db, pulse: z.infer<typeof Account>, repo: string, no: number, merger: string, state: string, url: string): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, issue_no) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
      state = excluded.state, evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence`)
    .run(pulse.id, repo, no, merger, state, pulse.measured_at.slice(0, 10), url)
  const row = db.prepare('SELECT id FROM targets WHERE repo = ? AND issue_no = ?').get(repo, no) as { id: number }
  return row.id
}

function planFor(db: Db, pipe: string, target: number): number {
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number } | undefined
  if (row === undefined) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const open = db.prepare("SELECT id FROM plans WHERE target_id = ? AND state IN ('queued', 'running')").get(target) as { id: number } | undefined
  if (open !== undefined) return open.id
  const made = db.prepare("INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries) VALUES (?, ?, 'pr_path', 'queued', ?, 0, 0)")
    .run(row.id, target, new Date().toISOString())
  return Number(made.lastInsertRowid)
}
