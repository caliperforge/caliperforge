import { z } from 'zod'
import { logged } from './events.ts'
import type { Db } from './index.ts'
import { held } from './leases.ts'
import { clock, openPipes } from './plans.ts'

export const LaneCap = z.object({
  dial: z.int(),
  band: z.int().nullable(),
  ceiling: z.int(),
  cap: z.int(),
})

export type LaneCap = z.infer<typeof LaneCap>

export const LaneState = LaneCap.extend({ live: z.int(), open: z.int() })

export type LaneState = z.infer<typeof LaneState>

export const WindowRow = z.object({
  kind: z.enum(['five_hour', 'seven_day']),
  runs: z.int(),
  tokens: z.int(),
  utilisation: z.number().nullable(),
  status: z.string().nullable(),
  observed_at: z.string().nullable(),
  resets_at: z.string().nullable(),
  dial: z.int(),
  band: z.int().nullable(),
  ceiling: z.int(),
  cap: z.int(),
})

export type WindowRow = z.infer<typeof WindowRow>

/** The shape `RateLimitEvent` arrives in, the same one v1 parked in `ops/state/plan_usage.json`. */
export const Reading = z.object({
  observed_at: z.string(),
  rate_limit_type: z.enum(['five_hour', 'seven_day']),
  resets_at: z.number(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  utilization: z.number().min(0),
})

export type Reading = z.infer<typeof Reading>

const BY_PR = 'lanes.band.'

export function get(db: Db, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (row === undefined) throw new Error(`no settings row "${key}"`)
  return row.value
}

export function ratchetRules(db: Db): { mode: 'warn' | 'refuse'; raises: Record<string, number> } {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key = 'ratchet.mode' OR key GLOB 'ratchet.raise.*'")
    .all() as { key: string; value: string }[]
  const refuse = rows.some((r) => r.key === 'ratchet.mode' && r.value === 'refuse')
  const raises = Object.fromEntries(rows.filter((r) => r.key !== 'ratchet.mode').map((r) => [r.key, Number(r.value)]))
  return { mode: refuse ? 'refuse' : 'warn', raises }
}

export function count(db: Db, key: string): number {
  return Number(get(db, key))
}

export function set(db: Db, key: string, value: string, who: 'ceo' | 'pr', at: string): void {
  if (key.startsWith(BY_PR)) throw new Error(`"${key}" is a usage band; it moves by pr, in a migration`)
  const done = db.prepare('UPDATE settings SET value = ?, who = ?, set_at = ? WHERE key = ?').run(value, who, at, key)
  if (done.changes === 0) throw new Error(`no settings row "${key}"; a new key is born in a migration`)
}

export function priority(db: Db, plan: number, n: number, actor?: string): void {
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error('cf priority takes P0 to P9')
  const done = db.prepare('UPDATE plans SET priority = ? WHERE id = ?').run(n, plan)
  if (done.changes === 0) throw new Error(`no plan ${String(plan)}`)
  if (actor !== undefined) logged(db, { plan, kind: 'priority', actor, outcome: 'pass', message: `P${String(n)}`, pointer: null, run: null })
}

export function templatePriority(db: Db, template: string): number {
  return count(db, `priority.default.${template}`)
}

/** The zone rule, read once: `tick.zone_offset_minutes` is the only place a window's timezone is written. */
export function zone(db: Db): number {
  return count(db, 'tick.zone_offset_minutes')
}

export function hhmm(db: Db, now: Date = new Date()): string {
  return clock(now, zone(db))
}

/** #148: what one run may spend before it stops. Under `plan.token_ceiling`, so it is the brake that acts first. */
export function wall(db: Db): number {
  return count(db, 'run.token_wall')
}

export function cap(db: Db): LaneCap {
  return LaneCap.parse(db.prepare('SELECT dial, band, ceiling, cap FROM lane_cap').get())
}

export function dial(db: Db, n: number, at: string): void {
  const ceiling = count(db, 'lanes.ceiling')
  if (!Number.isInteger(n) || n < 0 || n > ceiling) throw new Error(`cf lanes takes 0 to ${String(ceiling)}`)
  set(db, 'lanes.dial', String(n), 'ceo', at)
}

export function lanes(db: Db, hhmm: string, now: Date = new Date()): LaneState {
  const wide = cap(db)
  const running = db.prepare("SELECT id FROM plans WHERE state = 'running'").all() as { id: number }[]
  const live = new Set([...running.map((p) => p.id), ...held(db, now).map((l) => l.plan)])
  const open = openPipes(db, hhmm).slice(0, wide.cap).reduce((sum, p) => sum + p.max_concurrent, 0)
  return { ...wide, live: live.size, open }
}

export function windows(db: Db): WindowRow[] {
  return db.prepare('SELECT * FROM machine_window ORDER BY kind').all().map((r) => WindowRow.parse(r))
}

export function record(db: Db, reading: Reading): void {
  db.prepare(`INSERT OR IGNORE INTO usage (kind, utilisation, status, resets_at, observed_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(reading.rate_limit_type, reading.utilization, reading.status,
      new Date(reading.resets_at * 1000).toISOString(), reading.observed_at)
}

/** Every reading a run brought back; a provider that reports none leaves the band where it was. */
export function observed(db: Db, readings: Reading[] = []): void {
  for (const reading of readings) record(db, reading)
}

/** `spot` is the fourth step of the band: the machine opens nothing and a run is fired by hand. */
export function name(n: number | null): string {
  if (n === null) return 'none'
  return n === 0 ? 'spot' : String(n)
}
