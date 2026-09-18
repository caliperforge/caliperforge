import type { Db } from '../store/index.ts'

export interface PlanLine {
  id: number
  step: number
  state: string
  repo: string | null
  issue_no: number | null
}

export interface Day {
  runs: number
  tokens: number
  seconds: number
}

const LINES = `SELECT p.id, p.step, p.state, t.repo, t.issue_no
  FROM plans p LEFT JOIN targets t ON t.id = p.target_id`

export function open(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state IN ('queued', 'running') AND p.step <> 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function halted(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'halted' ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function awaiting(db: Db): PlanLine[] {
  return db.prepare(`${LINES} WHERE p.state = 'blocked_on_ceo' OR p.step = 7 ORDER BY p.queued_at, p.id`).all() as PlanLine[]
}

export function day(db: Db): Day {
  return db.prepare(`SELECT count(*) AS runs,
    coalesce(sum(input_tokens + cache_tokens + output_tokens), 0) AS tokens,
    coalesce(sum(seconds), 0) AS seconds
    FROM runs WHERE julianday(at) >= julianday('now', '-1 day')`).get() as Day
}

export function line(p: PlanLine): string {
  const target = p.repo === null ? '-' : `${p.repo}#${String(p.issue_no ?? 0)}`
  return `  plan ${String(p.id)}\tstep ${String(p.step)}\t${p.state}\t${target}`
}

export function section(title: string, rows: PlanLine[]): string {
  const body = rows.length === 0 ? '  none\n' : `${rows.map(line).join('\n')}\n`
  return `${title} (${String(rows.length)})\n${body}`
}

export function runsOf(db: Db, plan: number): Record<string, string | number>[] {
  return db.prepare('SELECT id, step, seat, exit FROM runs WHERE plan = ? ORDER BY id').all(plan) as Record<string, string | number>[]
}

export function verdictsOf(db: Db, plan: number): Record<string, string | number | null>[] {
  return db.prepare('SELECT id, gate, step, outcome, origin_ref FROM verdicts WHERE plan = ? ORDER BY id')
    .all(plan) as Record<string, string | number | null>[]
}
