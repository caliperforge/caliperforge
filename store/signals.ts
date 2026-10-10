import { z } from 'zod'
import type { Db } from './index.ts'

export const SignalRow = z.object({
  id: z.int(),
  repo: z.string(),
  pr: z.int(),
  kind: z.enum(['comment', 'review', 'bot_review', 'merge', 'ci_red']),
  author: z.string(),
  at: z.string(),
  external_id: z.string(),
  score: z.int().nullable(),
  plan: z.int().nullable(),
  body: z.string().nullable(),
  state: z.string().nullable(),
  head: z.string().nullable(),
})

export type SignalRow = z.infer<typeof SignalRow>

export type Signal = Omit<SignalRow, 'id' | 'body' | 'state' | 'head'> & { body?: string | null; state?: string | null; head?: string | null }

/** The tick re-reads the same PR every run; the row is keyed so a replay writes nothing. */
export function record(db: Db, signal: Signal): SignalRow | null {
  const written = db.prepare(`INSERT OR IGNORE INTO signals
    (repo, pr, kind, author, at, external_id, score, plan, body, state, head) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(signal.repo, signal.pr, signal.kind, signal.author, signal.at, signal.external_id, signal.score, signal.plan,
      signal.body ?? null, signal.state ?? null, signal.head ?? null)
  if (written.changes === 0) return null
  return SignalRow.parse(db.prepare('SELECT * FROM signals WHERE id = ?').get(Number(written.lastInsertRowid)))
}

export function graded(db: Db, plan: number, head: string): SignalRow | null {
  const row: unknown = db.prepare("SELECT * FROM signals WHERE plan = ? AND kind = 'bot_review' AND head = ? ORDER BY id DESC LIMIT 1")
    .get(plan, head)
  return row === undefined ? null : SignalRow.parse(row)
}

/** Greptile reviews in the month on repos matching `repos`, of plans with no origin. */
export function greptiled(db: Db, repos: string, month: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM signals s JOIN plans p ON p.id = s.plan
    WHERE s.kind = 'bot_review' AND s.author LIKE '%greptile%' AND s.repo GLOB ? AND p.origin IS NULL AND substr(s.at, 1, 7) = ?`)
    .get(repos, month) as { n: number }
  return row.n
}

/** Each head Greptile scored in the last 30 days on repos matching `repos`, of plans with no origin that passed both reviewers; its newest score decides. */
export function heads(db: Db, repos: string, now: Date): { plan: number; head: string; score: number | null }[] {
  return db.prepare(`SELECT plan, head, score FROM (SELECT s.plan, s.head, s.score,
      row_number() OVER (PARTITION BY s.plan, s.head ORDER BY s.id DESC) AS n
    FROM signals s JOIN plans p ON p.id = s.plan
    WHERE s.kind = 'bot_review' AND s.author LIKE '%greptile%' AND s.repo GLOB ? AND s.head IS NOT NULL AND p.origin IS NULL
      AND julianday(s.at) >= julianday(?, '-30 day')
      AND (SELECT count(DISTINCT v.gate) FROM verdicts v
        WHERE v.plan = s.plan AND v.outcome = 'pass' AND v.gate IN ('review', 'senior_review')) = 2)
    WHERE n = 1 ORDER BY plan, head`).all(repos, now.toISOString()) as { plan: number; head: string; score: number | null }[]
}

/** Each PR head Greptile reviewed in the last 30 days on repos matching `repos`, of plans with no origin. */
export function scored(db: Db, repos: string, now: Date): { plan: number; repo: string; pr: number; head: string }[] {
  return db.prepare(`SELECT DISTINCT s.plan, s.repo, s.pr, s.head FROM signals s JOIN plans p ON p.id = s.plan
    WHERE s.kind = 'bot_review' AND s.author LIKE '%greptile%' AND s.repo GLOB ? AND s.head IS NOT NULL AND p.origin IS NULL
      AND julianday(s.at) >= julianday(?, '-30 day')
    ORDER BY s.plan, s.pr, s.head`).all(repos, now.toISOString()) as { plan: number; repo: string; pr: number; head: string }[]
}

export function since(db: Db, plan: number): SignalRow[] {
  return db.prepare('SELECT * FROM signals WHERE plan = ? ORDER BY id').all(plan).map((r) => SignalRow.parse(r))
}

/** Reviews and comments with words on the plan's own upstream pull request since its newest passing push, or since it was queued. */
export function asks(db: Db, plan: number): SignalRow[] {
  return db.prepare(`SELECT s.* FROM signals s JOIN plans p ON p.id = s.plan JOIN targets t ON t.id = p.target_id
    WHERE s.plan = ? AND s.kind IN ('review', 'comment') AND trim(coalesce(s.body, ''), ' ' || char(9, 10, 13)) != '' AND s.repo = t.repo
      AND julianday(s.at) > coalesce((SELECT max(julianday(e.at)) FROM events e
        WHERE e.plan = p.id AND e.kind = 'push' AND e.outcome = 'pass'), julianday(p.queued_at))
    ORDER BY s.id`).all(plan).map((r) => SignalRow.parse(r))
}

export function others(db: Db, author: string): SignalRow[] {
  return db.prepare('SELECT * FROM signals WHERE author != ? ORDER BY id').all(author).map((r) => SignalRow.parse(r))
}

export function dropSignals(db: Db): void {
  db.prepare('DELETE FROM signals').run()
}
