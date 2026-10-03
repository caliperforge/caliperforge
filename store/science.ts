import { SELF } from '../sequencer/workspace.ts'
import type { Db } from './index.ts'

export interface Days { zone: number; since: string; today: string }

type Cell = string | number | null

export const DAILY = {
  runs_daily: "SELECT date(at, printf('%+d minutes', :zone)) AS date, seat, count(*) AS runs, sum(input_tokens + cache_read_tokens + output_tokens) AS tokens, sum(cost_computed_usd) AS cost_computed_usd, sum(cost_usd) AS cost_usd FROM runs WHERE date(at, printf('%+d minutes', :zone)) BETWEEN :since AND :today GROUP BY 1, 2 ORDER BY 1, 2",
  plans_daily: "SELECT date, lane, sum(kind = 'landed') AS landed, sum(kind = 'refused') AS refused, sum(kind = 'opened') AS opened FROM (SELECT date(queued_at, printf('%+d minutes', :zone)) AS date, id AS plan, lane, 'opened' AS kind FROM plans UNION ALL SELECT date(s.at, printf('%+d minutes', :zone)), p.id, p.lane, 'landed' FROM signals s JOIN plans p ON p.id = s.plan WHERE s.kind = 'merge' UNION ALL SELECT DISTINCT date(r.at, printf('%+d minutes', :zone)), p.id, p.lane, 'refused' FROM refusals r JOIN plans p ON p.id = r.plan WHERE r.blip = 0) WHERE date BETWEEN :since AND :today GROUP BY date, lane ORDER BY date, lane",
  drift_daily: "WITH RECURSIVE days(day) AS (SELECT :since UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today), drift AS (SELECT date(opened_at, printf('%+d minutes', :zone)) AS opened, date(closed_at, printf('%+d minutes', :zone)) AS closed FROM tickets WHERE repo = :self AND title GLOB 'Drift: *') SELECT day AS date, (SELECT count(*) FROM drift WHERE opened <= day AND (closed IS NULL OR closed > day)) AS open, (SELECT count(*) FROM drift WHERE opened = day) AS opened, (SELECT count(*) FROM drift WHERE closed = day) AS closed FROM days ORDER BY day",
  operator_daily: "WITH RECURSIVE days(day) AS (SELECT :since UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today) SELECT d.day AS date, coalesce(sum(e.actor = 'ceo'), 0) AS ceo, coalesce(sum(e.actor = 'coo'), 0) AS coo, coalesce(sum(e.kind = 'signoff'), 0) AS signoffs FROM days d LEFT JOIN events e ON date(e.at, printf('%+d minutes', :zone)) = d.day GROUP BY d.day ORDER BY d.day",
} as const

export function daily(db: Db, sql: string, days: Days): { columns: string[]; rows: Cell[][] } {
  const statement = db.prepare(sql)
  return { columns: statement.columns().map((c) => c.name), rows: statement.raw().all({ ...days, self: SELF }) as Cell[][] }
}
