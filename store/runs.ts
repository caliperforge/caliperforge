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
