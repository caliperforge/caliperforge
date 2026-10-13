import Database from 'better-sqlite3'
import type { Db } from './index.ts'
import type { Cell } from './science.ts'

const INPUT = 'input_tokens - coalesce(cache_write_tokens, 0)'

export const METRICS = {
  daily_activity: `WITH RECURSIVE days(day) AS (SELECT date(min(at)) FROM runs UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today) SELECT day, count(runs.id) AS runs, coalesce(sum(${INPUT}), 0) AS input_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens, coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(input_tokens + cache_read_tokens + output_tokens), 0) AS total_tokens FROM days LEFT JOIN runs ON date(at) = day WHERE day IS NOT NULL GROUP BY day ORDER BY day`,
  token_mix: `SELECT 'input' AS type, coalesce(sum(${INPUT}), 0) AS tokens FROM runs UNION ALL SELECT 'cache_read', coalesce(sum(cache_read_tokens), 0) FROM runs UNION ALL SELECT 'cache_write', coalesce(sum(cache_write_tokens), 0) FROM runs UNION ALL SELECT 'output', coalesce(sum(output_tokens), 0) FROM runs`,
  runs_by_seat: 'SELECT seat, count(*) AS runs FROM runs GROUP BY seat ORDER BY runs DESC, seat',
} as const

export function reader(path: string): Db {
  return new Database(path, { readonly: true, fileMustExist: true })
}

export function metric(db: Db, sql: string, today: string): { columns: string[]; rows: Cell[][] } {
  const statement = db.prepare(sql)
  return { columns: statement.columns().map((c) => c.name), rows: statement.raw().all({ today }) as Cell[][] }
}
