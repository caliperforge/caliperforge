import type { Run } from './events.ts'
import type { Db } from './index.ts'

interface RunTokens { id: number; seat: string; input_tokens: number; cache_read_tokens: number; output_tokens: number; transcript_path: string; mode: Run['mode'] | null }

export function runTokens(db: Db, plan: number): RunTokens[] {
  return db.prepare(`SELECT id, seat, input_tokens, cache_read_tokens, output_tokens, transcript_path, mode
    FROM runs WHERE plan = ? ORDER BY id`).all(plan) as RunTokens[]
}

export function setInputTokens(db: Db, tokens: number): void {
  db.prepare('UPDATE runs SET input_tokens = ?').run(tokens)
}

export function lastTranscript(db: Db, plan: number, step: number): string {
  const row = db.prepare('SELECT transcript_path FROM runs WHERE plan = ? AND step = ? ORDER BY id DESC LIMIT 1')
    .get(plan, step) as { transcript_path: string | null } | undefined
  return row?.transcript_path ?? ''
}

export function backdate(db: Db): void {
  db.prepare("UPDATE runs SET at = datetime('now', '-2 minutes')").run()
}

export function spentLately(db: Db, tokens: number): void {
  db.prepare(`UPDATE runs SET input_tokens = ?, at = datetime('now', '+1 minute')
    WHERE julianday(at) > julianday('now', '-1 minute')`).run(tokens)
}
