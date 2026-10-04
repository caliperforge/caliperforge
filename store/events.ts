import type { Fired, Provider } from '../providers/kind.ts'
import type { Db } from './index.ts'
import type { Verdict } from './verdict.ts'

export interface Event {
  plan: number | null
  kind: string
  actor: string
  outcome: Verdict['outcome']
  message: string
  pointer: string | null
  run: number | null
}

export function logged(db: Db, e: Event, at: string | null = null): number {
  const row = db.prepare(`INSERT INTO events (plan, kind, actor, outcome, message, pointer, run, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, coalesce(?, CURRENT_TIMESTAMP))`)
    .run(e.plan, e.kind, e.actor, e.outcome, e.message, e.pointer, e.run, at)
  return Number(row.lastInsertRowid)
}

export function pointers(db: Db, kind: string): (string | null)[] {
  return db.prepare('SELECT pointer FROM events WHERE kind = ? ORDER BY id').pluck().all(kind) as (string | null)[]
}

export function eventsOf(db: Db, plan: number, kind: string): Pick<Event, 'actor' | 'outcome' | 'message'>[] {
  return db.prepare('SELECT actor, outcome, message FROM events WHERE plan = ? AND kind = ? ORDER BY id')
    .all(plan, kind) as Pick<Event, 'actor' | 'outcome' | 'message'>[]
}

export function ofKind(db: Db, ...kinds: string[]): Pick<Event, 'plan' | 'kind' | 'actor' | 'outcome' | 'message'>[] {
  return db.prepare('SELECT plan, kind, actor, outcome, message FROM events WHERE kind IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(kinds)) as Pick<Event, 'plan' | 'kind' | 'actor' | 'outcome' | 'message'>[]
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
  fired: Pick<Fired, 'usage' | 'seconds' | 'transcript_path' | 'session'>
  mode?: 'build' | 'review' | 'fix' | undefined
}

// input_tokens already counts cache_write_tokens, so the uncached part is their difference.
const PRICED = `UPDATE runs SET cost_computed_usd = (
    SELECT ((runs.input_tokens - runs.cache_write_tokens) * p.input + (runs.cache_write_tokens - runs.cache_write_1h_tokens) * p.cache_write
      + runs.cache_write_1h_tokens * p.cache_write_1h + runs.cache_read_tokens * p.cache_read + runs.output_tokens * p.output) / 1e6
    FROM prices p WHERE p.provider = runs.provider AND p.model = runs.model AND julianday(p.effective_from) <= julianday(runs.at)
    ORDER BY julianday(p.effective_from) DESC LIMIT 1)
  WHERE cache_write_tokens IS NOT NULL`

export function runLogged(db: Db, r: Run): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, cost_usd, cache_write_tokens,
    cache_write_1h_tokens, session, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.plan, r.step, r.seat, r.rule_hash, r.provider, r.model, r.effort, r.fired.usage.input, r.fired.usage.cache,
      r.fired.usage.output, r.fired.seconds, r.exit, r.fired.transcript_path, r.fired.usage.cost ?? null, r.fired.usage.write ?? null,
      r.fired.usage.write_1h ?? null, r.fired.session ?? null, r.mode ?? null)
  const id = Number(row.lastInsertRowid)
  db.prepare(`${PRICED} AND id = ?`).run(id)
  return id
}

export function repriced(db: Db): { priced: number; missing: number[] } {
  const filled = db.prepare(`${PRICED} AND cost_computed_usd IS NULL RETURNING cost_computed_usd`)
    .all() as { cost_computed_usd: number | null }[]
  const missing = db.prepare('SELECT id FROM runs WHERE cache_write_tokens IS NULL ORDER BY id').pluck().all() as number[]
  return { priced: filled.filter((r) => r.cost_computed_usd !== null).length, missing }
}

export function runAt(db: Db, plan: number, step: number, seat: string, at: string): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model,
    effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path)
    VALUES (?, ?, ?, ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, ?, 'x.transcript.jsonl')`)
    .run(plan, step, seat, '0'.repeat(64), at)
  return Number(row.lastInsertRowid)
}

export function runRows(db: Db): { plan: number; seat: string; step: number; exit: number; transcript_path: string }[] {
  return db.prepare('SELECT plan, seat, step, exit, transcript_path FROM runs ORDER BY id')
    .all() as { plan: number; seat: string; step: number; exit: number; transcript_path: string }[]
}

export interface HandUps { decided: number; up: number }

export function handUps(db: Db, now: Date): HandUps {
  return db.prepare(`SELECT coalesce(sum(outcome = 'pass'), 0) AS decided, coalesce(sum(outcome = 'needs_ceo'), 0) AS up
    FROM events WHERE kind = 'coo_lite' AND julianday(at) >= julianday(?, '-7 day')`).get(now.toISOString()) as HandUps
}

export function kindsOf(db: Db, plan: number): Pick<Event, 'kind' | 'outcome'>[] {
  return db.prepare('SELECT kind, outcome FROM events WHERE plan = ? ORDER BY id').all(plan) as Pick<Event, 'kind' | 'outcome'>[]
}
