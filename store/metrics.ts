import Database from 'better-sqlite3'
import type { Db } from './index.ts'
import type { Cell } from './science.ts'

const INPUT = 'input_tokens - coalesce(cache_write_tokens, 0)'

const GATE_AT = `CASE gate ${['pre_review', 'review', 'senior_review', 'blind_review', 'ready'].map((g, i) => `WHEN '${g}' THEN ${String(i)}`).join(' ')} END`

const gated = (stage: string, gate: string): string =>
  `SELECT '${stage}', count(*), coalesce(sum(outcome = 'refuse'), 0), 'verdicts' FROM verdicts WHERE gate = '${gate}'`

const STAGES = [
  "SELECT 'brief' AS stage, count(*) AS count, NULL AS refused, 'runs' AS unit FROM runs WHERE seat = 'brief_writer'",
  "SELECT 'build', count(*), NULL, 'runs' FROM runs WHERE seat GLOB '*_specialist'",
  gated('rails', 'pre_review'), gated('code review', 'review'), gated('senior review', 'senior_review'), gated('ready', 'ready'),
  "SELECT 'CEO approvals', count(*), NULL, 'approvals' FROM approvals WHERE who = 'ceo' AND decision = 'approved'",
  "SELECT 'pushed', count(*), NULL, 'deliverables' FROM deliverables WHERE state = 'pushed'",
]

const KINDS = ['signoff', 'return', 'priority', 'retry', 'card', 'filed', 'pipe', 'desk_approve']

export const METRICS = {
  daily_activity: `WITH RECURSIVE days(day) AS (SELECT date(min(at)) FROM runs UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today) SELECT day, count(runs.id) AS runs, coalesce(sum(${INPUT}), 0) AS input_tokens, coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens, coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens, coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(input_tokens + cache_read_tokens + output_tokens), 0) AS total_tokens FROM days LEFT JOIN runs ON date(at) = day WHERE day IS NOT NULL GROUP BY day ORDER BY day`,
  token_mix: `SELECT 'input' AS type, coalesce(sum(${INPUT}), 0) AS tokens FROM runs UNION ALL SELECT 'cache_read', coalesce(sum(cache_read_tokens), 0) FROM runs UNION ALL SELECT 'cache_write', coalesce(sum(cache_write_tokens), 0) FROM runs UNION ALL SELECT 'output', coalesce(sum(output_tokens), 0) FROM runs`,
  runs_by_seat: 'SELECT seat, count(*) AS runs FROM runs GROUP BY seat ORDER BY runs DESC, seat',
  gate_verdicts: `SELECT gate, outcome, count(*) AS count FROM verdicts WHERE ${GATE_AT} IS NOT NULL GROUP BY gate, outcome ORDER BY ${GATE_AT}, outcome`,
  plan_outcomes: 'SELECT template, state, count(*) AS count FROM plans GROUP BY template, state ORDER BY template, state',
  pipeline_counts: `SELECT stage, count, refused, unit FROM (${STAGES.map((s, i) => `SELECT ${String(i)} AS at, * FROM (${s})`).join(' UNION ALL ')}) ORDER BY at`,
  tokens_per_landed_job: "SELECT week, count(*) AS jobs, round(avg(total), 1) AS mean_total_tokens, round(avg(fresh), 1) AS mean_fresh_tokens, round(avg(cache_read), 1) AS mean_cache_read_tokens, round(avg(runs), 1) AS mean_runs FROM (SELECT date(plans.queued_at, 'weekday 0', '-6 days') AS week, sum(input_tokens + cache_read_tokens + output_tokens) AS total, sum(input_tokens + output_tokens) AS fresh, sum(cache_read_tokens) AS cache_read, count(*) AS runs FROM plans JOIN runs ON runs.plan = plans.id WHERE plans.state = 'done' GROUP BY plans.id) GROUP BY week ORDER BY week",
  ceo_touches: `WITH RECURSIVE days(day) AS (SELECT date(min(at)) FROM events WHERE actor = 'ceo' UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < :today) SELECT day, count(events.id) AS touches, ${KINDS.map((k) => `coalesce(sum(kind = '${k}'), 0) AS ${k}`).join(', ')}, coalesce(sum(kind NOT IN (${KINDS.map((k) => `'${k}'`).join(', ')})), 0) AS other FROM days LEFT JOIN events ON date(at) = day AND actor = 'ceo' WHERE day IS NOT NULL GROUP BY day ORDER BY day`,
} as const

export function reader(path: string): Db {
  return new Database(path, { readonly: true, fileMustExist: true })
}

export function metric(db: Db, sql: string, today: string): { columns: string[]; rows: Cell[][] } {
  const statement = db.prepare(sql)
  return { columns: statement.columns().map((c) => c.name), rows: statement.raw().all({ today }) as Cell[][] }
}
