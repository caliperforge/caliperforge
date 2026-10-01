import { z } from 'zod'
import { targetDigest } from '../sequencer/approve.ts'
import type { Check, Target } from '../sequencer/card.ts'
import { picked } from '../sequencer/theirs.ts'
import { branchOf, checkout, put } from '../sequencer/workspace.ts'
import { decide } from '../store/approvals.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { templatePriority } from '../store/lanes.ts'
import { end, type Holder } from '../store/plans.ts'
import { profile } from '../store/profile.ts'
import { latest } from '../store/rulings.ts'
import { claimed, gh, implemented, issue as readIssue, lastMerger, WINDOW, type Issue, type Read } from './gh.ts'
import { measure } from './measure.ts'

const Account = z.object({ id: z.int(), measured_at: z.string(), pulse: z.enum(['warm', 'cold']) })

const URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/

export interface Origin {
  origin_kind: 'ruling'
  origin_ref: string
}

const IMPLEMENTED: Origin = { origin_kind: 'ruling', origin_ref: 'queue.implemented' }

interface Added {
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
interface Scope {
  card?: string
  pr?: string
  /** One item of the issue, which the card scopes; its own target, plan and branch. */
  part?: string
}

const PART = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * A target is queued however slowly the repo merges: targets are picked by hand, not by the pulse, which is
 * measured here when missing or old and kept as data. A card of ours scopes one item of their
 * issue, so an issue other pull requests already touch is still open to it.
 */
export function add(db: Db, root: string, repo: string, url: string, pipe: string, today: string, scope: Scope = {}): Added {
  const no = parse(repo, url)
  const part = scope.part ?? ''
  if (part !== '' && !PART.test(part)) throw new Error(`part "${part}" is not a lowercase slug of at most 32 characters`)
  if (part !== '' && scope.card === undefined) throw new Error('a part is one item of the issue; name it with --ask')
  const pulse = measured(db, repo, today)
  const row = readIssue(repo, no)
  const merger = lastMerger(repo)
  const claim = claimed(row)
  const shipped = claim === null && scope.card === undefined ? implemented(repo, row) : null
  const why = claim ?? shipped ?? (merger === null ? `${repo} has no named merger` : null)
  const state = why !== null ? 'refused' : 'ready'
  const origin = shipped !== null ? IMPLEMENTED : null
  const target = upsert(db, pulse, repo, no, part, merger ?? '', state, url, ruling(db, origin, state))
  if (why !== null) return { target, plan: null, state, why, origin }
  const plan = planFor(db, pipe, target, url, 'cf queue add')
  put(root, plan, 'ask.md', askOf(row, scope.card))
  if (scope.pr !== undefined) put(root, plan, 'pr.md', scope.pr)
  return { target, plan, state, why: `${repo}#${String(no)}${part === '' ? '' : ` ${part}`} queued`, origin }
}

export function askOf(row: Pick<Issue, 'title' | 'body'>, card: string | undefined): string {
  const theirs = `# ${row.title}\n\n${row.body}\n`
  if (card === undefined) return theirs
  return `${card.trimEnd()}\n\n${CARD}\n\n${theirs.replace(/^#/gm, '###')}`
}

export const CARD = '## Their issue, for context only; the scope is the card above'

const Opened = z.array(z.object({ createdAt: z.string() }))

/** The first intake rule of the repo's profile this target breaks, named, or null. */
export function waits(db: Db, root: string, repo: string, no: number, read: Read = gh, now = new Date()): string | null {
  const rules = profile(root, repo)?.intake
  if (rules === undefined) return null
  const claim = `claim.${repo}#${String(no)}`
  if (rules.claim_first && latest(db, claim)?.value !== 'confirmed') return `claim_first: no ruling ${claim} = confirmed`
  const ours = (state: string, field: string): unknown[] => z.array(z.unknown()).parse(read(['pr', 'list', '--repo', repo,
    '--author', '@me', '--state', state, '--limit', String(WINDOW), '--json', field]))
  const cap = rules.max_open_prs
  const open = cap === undefined ? 0 : ours('open', 'number').length
  if (cap !== undefined && open >= cap) return `max_open_prs: ${String(open)} of ours open in ${repo}, cap ${String(cap)}`
  if (rules.pace === undefined) return null
  const { prs, days } = rules.pace
  const since = now.getTime() - days * 86400000
  const opened = Opened.parse(ours('all', 'createdAt')).filter((p) => Date.parse(p.createdAt) >= since).length
  return opened >= prs ? `pace: ${String(opened)} opened in ${repo} in the last ${String(days)} days, cap ${String(prs)}` : null
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

function upsert(db: Db, pulse: z.infer<typeof Account>, repo: string, no: number, part: string, merger: string, state: string, url: string, ruled: number | null): number {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, part, named_merger, state, evidence_measured_at, evidence, ineligible_ruling_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, issue_no, part) DO UPDATE SET account_id = excluded.account_id, named_merger = excluded.named_merger,
      state = excluded.state, evidence_measured_at = excluded.evidence_measured_at, evidence = excluded.evidence,
      ineligible_ruling_id = excluded.ineligible_ruling_id`)
    .run(pulse.id, repo, no, part, merger, state, pulse.measured_at.slice(0, 10), url, ruled)
  const row = db.prepare('SELECT id FROM targets WHERE repo = ? AND issue_no = ? AND part = ?').get(repo, no, part) as { id: number }
  return row.id
}

interface Scanned { repo: string; issue_no: number; part: string; evidence_measured_at: string; state: string; evidence: string }

function targetOf(db: Db, id: number): Scanned {
  const t = db.prepare('SELECT repo, issue_no, part, evidence_measured_at, state, evidence FROM targets WHERE id = ?').get(id) as Scanned | undefined
  if (t === undefined) throw new Error(`no target ${String(id)}`)
  return t
}

export function vetted(db: Db, root: string, plan: number, id: number, check: Check): string | null {
  const target = db.prepare('SELECT repo, issue_no, named_merger FROM targets WHERE id = ?').get(id) as Target
  const { ok, says } = check(db, root, plan, target)
  if (ok) return null
  refuseTarget(db, id, 'their.work')
  db.prepare('UPDATE targets SET evidence = coalesce(?, evidence) WHERE id = ?').run(/https:\/\/\S+/.exec(says)?.[0] ?? null, id)
  return says
}

export function approve(db: Db, root: string, id: number, pipe: string, by: Holder, check: Check | null = picked()): { digest: string; plan: number | null } {
  const t = targetOf(db, id)
  if (t.state === 'refused') throw new Error(`target ${String(id)} is refused`)
  const unplanned = t.state === 'ready' && db.prepare('SELECT 1 FROM plans WHERE target_id = ?').get(id) === undefined
  const row = unplanned ? readIssue(t.repo, t.issue_no) : null
  const digest = targetDigest(t)
  const plan = row === null ? null : planFor(db, pipe, id, t.evidence, by)
  if (plan !== null && row !== null) put(root, plan, 'ask.md', askOf(row, undefined))
  if (plan !== null && check !== null) {
    checkout(root, plan, t.repo, branchOf(t.repo, t.issue_no, 1, t.part))
    const says = vetted(db, root, plan, id, check)
    if (says !== null) {
      end(db, plan, 'refused')
      throw new Error(`target ${String(id)} refused: ${says}`)
    }
  }
  db.transaction(() => {
    decide(db, 'target', id, digest, null)
    signed(db, id, by, 'pass', digest.slice(0, 12))
  })()
  return { digest, plan }
}

export function refuseTarget(db: Db, id: number, reason: string, by?: Holder): string {
  const digest = targetDigest(targetOf(db, id))
  db.transaction(() => {
    decide(db, 'target', id, digest, reason)
    db.prepare("UPDATE targets SET state = 'refused' WHERE id = ?").run(id)
    if (by !== undefined) signed(db, id, by, 'refuse', reason)
  })()
  return digest
}

function signed(db: Db, target: number, by: Holder, outcome: 'pass' | 'refuse', message: string): void {
  const plan = db.prepare('SELECT max(id) FROM plans WHERE target_id = ?').pluck().get(target) as number | null
  logged(db, { plan, kind: 'signoff', actor: by, outcome, message, pointer: `target:${String(target)}`, run: null })
}

export function note(db: Db, id: number, take: string): void {
  if (db.prepare('UPDATE targets SET coo_take = ? WHERE id = ?').run(take, id).changes === 0) throw new Error(`no target ${String(id)}`)
}

function planFor(db: Db, pipe: string, target: number, url: string, actor: string): number {
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number } | undefined
  if (row === undefined) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const open = db.prepare("SELECT id FROM plans WHERE target_id = ? AND state IN ('queued', 'running')").get(target) as { id: number } | undefined
  if (open !== undefined) return open.id
  const made = db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 'pr_path', 'queued', ?, 0, 0, ?)`)
    .run(row.id, target, new Date().toISOString(), templatePriority(db, 'pr_path'))
  const id = Number(made.lastInsertRowid)
  logged(db, { plan: id, kind: 'filed', actor, outcome: 'pass', message: url, pointer: null, run: null })
  return id
}
