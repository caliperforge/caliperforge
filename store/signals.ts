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

export function since(db: Db, plan: number): SignalRow[] {
  return db.prepare('SELECT * FROM signals WHERE plan = ? ORDER BY id').all(plan).map((r) => SignalRow.parse(r))
}
