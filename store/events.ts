import type { Fired, Provider } from '../providers/kind.ts'
import type { Db } from './index.ts'
import type { Verdict } from './verdict.ts'

export interface Event {
  plan: number
  kind: string
  actor: string
  outcome: Verdict['outcome']
  message: string
  pointer: string | null
  run: number | null
}

export function logged(db: Db, e: Event): number {
  const row = db.prepare(`INSERT INTO events (plan, kind, actor, outcome, message, pointer, run)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(e.plan, e.kind, e.actor, e.outcome, e.message, e.pointer, e.run)
  return Number(row.lastInsertRowid)
}

export function eventsOf(db: Db, plan: number, kind: string): Pick<Event, 'actor' | 'outcome' | 'message'>[] {
  return db.prepare('SELECT actor, outcome, message FROM events WHERE plan = ? AND kind = ? ORDER BY id')
    .all(plan, kind) as Pick<Event, 'actor' | 'outcome' | 'message'>[]
}

export function ofKind(db: Db, kind: string): Pick<Event, 'plan' | 'kind' | 'actor' | 'outcome' | 'message'>[] {
  return db.prepare('SELECT plan, kind, actor, outcome, message FROM events WHERE kind = ? ORDER BY id')
    .all(kind) as Pick<Event, 'plan' | 'kind' | 'actor' | 'outcome' | 'message'>[]
}

export function newestRun(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM runs').get() as { id: number }).id
}

export function runSince(db: Db, plan: number, step: number, after: number): number | null {
  return (db.prepare('SELECT max(id) AS id FROM runs WHERE plan = ? AND step = ? AND id > ?')
    .get(plan, step, after) as { id: number | null }).id
}

export interface Run {
  plan: number
  step: number
  seat: string
  rule_hash: string
  provider: Provider['name']
  model: string
  effort: string
  exit: number
  fired: Pick<Fired, 'usage' | 'seconds' | 'transcript_path'>
}

export function runLogged(db: Db, r: Run): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, cost_usd, cache_write_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.plan, r.step, r.seat, r.rule_hash, r.provider, r.model, r.effort, r.fired.usage.input, r.fired.usage.cache,
      r.fired.usage.output, r.fired.seconds, r.exit, r.fired.transcript_path, r.fired.usage.cost ?? null, r.fired.usage.write ?? null)
  return Number(row.lastInsertRowid)
}

export function runAt(db: Db, plan: number, step: number, seat: string, at: string): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model,
    effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path)
    VALUES (?, ?, ?, ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, ?, 'x.transcript.jsonl')`)
    .run(plan, step, seat, '0'.repeat(64), at)
  return Number(row.lastInsertRowid)
}

export function runRows(db: Db): { plan: number; seat: string; step: number; transcript_path: string }[] {
  return db.prepare('SELECT plan, seat, step, transcript_path FROM runs ORDER BY id')
    .all() as { plan: number; seat: string; step: number; transcript_path: string }[]
}
