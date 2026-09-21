import { z } from 'zod'
import { put } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { templatePriority } from '../store/lanes.ts'
import { claimed, implemented, issue as readIssue, lastMerger, type Issue } from './gh.ts'
import { measure } from './measure.ts'

const Account = z.object({ id: z.int(), measured_at: z.string(), pulse: z.enum(['warm', 'cold']) })

const URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/

export interface Origin {
  origin_kind: 'ruling'
  origin_ref: string
}

const IMPLEMENTED: Origin = { origin_kind: 'ruling', origin_ref: 'queue.implemented' }

export interface Added {
  target: number
  plan: number | null
  state: 'ready' | 'refused'
  why: string
  origin: Origin | null
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

/** Ours to say what the job is: `card` is the ask, their issue only its context; `pr` is the body the PR opens with. */
export interface Scope {
  card?: string
  pr?: string
}

/**
 * A target is queued however slowly the repo merges: the CEO picks targets, not the pulse, which is
 * measured here when missing or old and kept as data. A card of ours scopes one item of their
 * issue, so an issue other pull requests already touch is still open to it.
 */
export function add(db: Db, root: string, repo: string, url: string, pipe: string, today: string, scope: Scope = {}): Added {
  const no = parse(repo, url)
  const pulse = measured(db, repo, today)
  const row = readIssue(repo, no)
  const merger = lastMerger(repo)
  const claim = claimed(row)
  const shipped = claim === null && scope.card === undefined ? implemented(repo, row) : null
  const why = claim ?? shipped ?? (merger === null ? `${repo} has no named merger` : null)
  const state = why !== null ? 'refused' : 'ready'
  const origin = shipped !== null ? IMPLEMENTED : null
  const target = upsert(db, pulse, repo, no, merger ?? '', state, url, ruling(db, origin, state))
  if (why !== null) return { target, plan: null, state, why, origin }
  const plan = planFor(db, pipe, target)
  put(root, plan, 'ask.md', askOf(row, scope.card))
  if (scope.pr !== undefined) put(root, plan, 'pr.md', scope.pr)
  return { target, plan, state, why: `${repo}#${String(no)} queued`, origin }
}

export function askOf(row: Pick<Issue, 'title' | 'body'>, card: string | undefined): string {
  const theirs = `# ${row.title}\n\n${row.body}\n`
  if (card === undefined) return theirs
  return `${card.trimEnd()}\n\n## Their issue, for context only; the scope is the card above\n\n${theirs.replace(/^#/gm, '###')}`
}

function measured(db: Db, repo: string, today: string): z.infer<typeof Account> {
  try {
    return account(db, repo, today)
  } catch {
    measure(db, repo, today)
    return account(db, repo, today)
  }
}

/** `targets.ineligible_ruling_id` is the refused trip's law-4 home; the parked trip has no column, only the row. */
function ruling(db: Db, origin: Origin | null, state: string): number | null {
  if (origin === null || state !== 'refused') return null
  const row = db.prepare('SELECT id FROM rulings WHERE subject = ? ORDER BY id DESC LIMIT 1')
    .get(origin.origin_ref) as { id: number } | undefined
  return row?.id ?? null
}

function upsert(db: Db, pulse: z.infer<typeof Account>, repo: string, no: number, merger: string, state: string, url: string, ruled: number | null): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence, ineligible_ruling_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, issue_no) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
      state = excluded.state, evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
      ineligible_ruling_id = excluded.ineligible_ruling_id`)
    .run(pulse.id, repo, no, merger, state, pulse.measured_at.slice(0, 10), url, ruled)
  const row = db.prepare('SELECT id FROM targets WHERE repo = ? AND issue_no = ?').get(repo, no) as { id: number }
  return row.id
}

function planFor(db: Db, pipe: string, target: number): number {
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number } | undefined
  if (row === undefined) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const open = db.prepare("SELECT id FROM plans WHERE target_id = ? AND state IN ('queued', 'running')").get(target) as { id: number } | undefined
  if (open !== undefined) return open.id
  const made = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 'pr_path', 'queued', ?, 0, 0, ?)`)
    .run(row.id, target, new Date().toISOString(), templatePriority(db, 'pr_path'))
  return Number(made.lastInsertRowid)
}
