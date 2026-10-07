import type { Db } from './index.ts'
import type { WindowRow } from './lanes.ts'
import { BUILT, type Holder, type Wait } from './plans.ts'
import { until } from './until.ts'

export interface PlanLine {
  id: number
  step: number
  state: string
  repo: string | null
  issue_no: number | null
  held_why: string | null
}

interface Day {
  runs: number
  tokens: number
  seconds: number
}

export interface Ticket {
  plan: number
  origin: string | null
  target: string | null
  runs: number
  build: number
  review: number
  minutes: number
  tokens: number
  outcome: string
  early: number
}

const LINES = `SELECT p.id, p.step, p.state, t.repo, t.issue_no, p.held_why
  FROM plans p LEFT JOIN targets t ON t.id = p.target_id`

export function open(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state IN ('queued', 'running') AND p.step <> 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function halted(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'halted' ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function heldBy(db: Db, by: Holder): PlanLine[] {
  return (db.prepare(`${LINES} WHERE p.held_by = ? AND p.waits_on IS NULL ORDER BY p.queued_at, p.id`).all(by) as PlanLine[])
    .map((p) => ({ ...p, held_why: until(db, p.id) ?? p.held_why }))
}

export function day(db: Db): Day {
  return db.prepare(`SELECT count(*) AS runs,
    coalesce(sum(input_tokens + cache_read_tokens + output_tokens), 0) AS tokens,
    coalesce(sum(seconds), 0) AS seconds
    FROM runs WHERE julianday(at) >= julianday('now', '-1 day')`).get() as Day
}

const ACTORS = ['ceo', 'coo', 'director', 'orchestrator', 'fixer'] as const

type Actor = typeof ACTORS[number]

const SEATED: readonly Actor[] = ['director', 'orchestrator', 'fixer']

export interface ActorRow {
  actor: Actor
  kinds: { kind: string; n: number }[]
  runs: { runs: number; cost: number } | null
  scored: { held: number; missed: number; open: number }
}

export function actors(db: Db, now: Date): ActorRow[] {
  const at = now.toISOString()
  const kinds = db.prepare(`SELECT CASE actor WHEN 'coo_lite' THEN 'director' ELSE actor END AS actor, kind, count(*) AS n FROM events
    WHERE julianday(at) >= julianday(?, '-1 day') GROUP BY 1, kind ORDER BY kind`)
    .all(at) as { actor: string; kind: string; n: number }[]
  const runs = db.prepare(`SELECT CASE seat WHEN 'coo_lite' THEN 'director' ELSE seat END AS seat, count(*) AS runs,
    coalesce(sum(cost_usd), 0) AS cost FROM runs
    WHERE NOT (${BUILT}) AND julianday(at) >= julianday(?, '-1 day') GROUP BY 1`)
    .all(at) as { seat: string; runs: number; cost: number }[]
  const scored = db.prepare(`SELECT CASE actor WHEN 'coo_lite' THEN 'director' ELSE actor END AS actor, outcome, count(*) AS n FROM outcomes
    WHERE julianday(at) >= julianday(?, '-7 day') GROUP BY 1, outcome`)
    .all(at) as { actor: string; outcome: 'held' | 'missed' | 'open'; n: number }[]
  return ACTORS.map((actor) => ({
    actor,
    kinds: kinds.filter((k) => k.actor === actor).map(({ kind, n }) => ({ kind, n })),
    runs: SEATED.includes(actor) ? runs.find((r) => r.seat === actor) ?? { runs: 0, cost: 0 } : null,
    scored: scored.filter((s) => s.actor === actor).reduce((sum, s) => ({ ...sum, [s.outcome]: s.n }), { held: 0, missed: 0, open: 0 }),
  }))
}

/** Per-ticket usage is read as two eras, split at this instant. */
export const ERA = '2026-09-19 11:21'

const TICKETS = `SELECT p.id AS plan, p.origin, t.repo || '#' || t.issue_no AS target,
  count(*) AS runs,
  sum(r.step = 2 AND r.${BUILT}) AS build,
  sum(r.step IN (4, 5) AND r.${BUILT}) AS review,
  sum(r.seconds) / 60.0 AS minutes,
  sum(r.input_tokens + r.cache_read_tokens + r.output_tokens) AS tokens,
  CASE p.state WHEN 'done' THEN 'landed' WHEN 'refused' THEN 'wasted' WHEN 'halted' THEN 'wasted'
    ELSE 'open' END AS outcome,
  julianday(min(r.at)) < julianday(?) AS early
  FROM runs r JOIN plans p ON p.id = r.plan LEFT JOIN targets t ON t.id = p.target_id
  GROUP BY p.id ORDER BY max(r.at) DESC, p.id DESC`

export function tickets(db: Db): Ticket[] {
  return db.prepare(TICKETS).all(ERA) as Ticket[]
}

export function openIds(db: Db): number[] {
  return (db.prepare("SELECT id FROM plans WHERE state NOT IN ('done', 'refused') ORDER BY id").all() as { id: number }[]).map((p) => p.id)
}

export function runsOf(db: Db, plan: number): Record<string, string | number>[] {
  return db.prepare('SELECT id, step, seat, exit FROM runs WHERE plan = ? ORDER BY id').all(plan) as Record<string, string | number>[]
}

export function verdictsOf(db: Db, plan: number): Record<string, string | number | null>[] {
  return db.prepare('SELECT id, gate, step, outcome, origin_ref FROM verdicts WHERE plan = ? ORDER BY id')
    .all(plan) as Record<string, string | number | null>[]
}

export function waits(db: Db): { reason: Wait; plans: number }[] {
  return db.prepare(`SELECT wait_reason AS reason, count(*) AS plans FROM plans
    WHERE state IN ('queued', 'running') AND wait_reason IS NOT NULL
    GROUP BY wait_reason ORDER BY wait_reason`).all() as { reason: Wait; plans: number }[]
}

export type ByType = Pick<WindowRow, 'uncached_tokens' | 'cache_write_tokens' | 'cache_read_tokens' | 'output_tokens'>

export interface Cost extends ByType {
  provider: string
  model: string
  runs: number
  computed: number | null
  reported: number | null
}

export interface Model { provider: string; model: string }

const LAST_DAY = "julianday(at) >= julianday('now', '-1 day')"

export function costs(db: Db): Cost[] {
  return db.prepare(`SELECT provider, model, count(*) AS runs,
    sum(input_tokens - coalesce(cache_write_tokens, 0)) AS uncached_tokens, sum(coalesce(cache_write_tokens, 0)) AS cache_write_tokens,
    sum(cache_read_tokens) AS cache_read_tokens, sum(output_tokens) AS output_tokens,
    sum(cost_computed_usd) AS computed, sum(cost_usd) AS reported
    FROM runs WHERE ${LAST_DAY} GROUP BY provider, model ORDER BY provider, model`).all() as Cost[]
}

interface Run {
  plan: number
  step: number
  seat: string
  rule_hash: string
  provider: string
  model: string
  effort: string
  input_tokens: number
  cache_write_tokens: number | null
  cache_write_1h_tokens: number | null
  cache_read_tokens: number
  output_tokens: number
  seconds: number
  exit: number
  at: string
  transcript_path: string
  cost_usd: number | null
}

export function addRun(db: Db, row: Run): void {
  db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_write_tokens,
    cache_write_1h_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path, cost_usd)
    VALUES (@plan, @step, @seat, @rule_hash, @provider, @model, @effort, @input_tokens, @cache_write_tokens,
    @cache_write_1h_tokens, @cache_read_tokens, @output_tokens, @seconds, @exit, @at, @transcript_path, @cost_usd)`).run(row)
}

interface Price {
  provider: string
  model: string
  input: number
  cache_read: number
  cache_write: number
  cache_write_1h: number
  output: number
  effective_from: string
  source_url: string
}

export function addPrice(db: Db, row: Price): void {
  db.prepare(`INSERT INTO prices (provider, model, input, cache_read, cache_write, cache_write_1h, output, effective_from, source_url)
    VALUES (@provider, @model, @input, @cache_read, @cache_write, @cache_write_1h, @output, @effective_from, @source_url)`).run(row)
}

export function unpriced(db: Db): Model[] {
  return db.prepare(`SELECT DISTINCT provider, model FROM runs r WHERE ${LAST_DAY}
    AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.provider = r.provider AND p.model = r.model
      AND julianday(p.effective_from) <= julianday(r.at))
    ORDER BY provider, model`).all() as Model[]
}
