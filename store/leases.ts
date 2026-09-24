import type { Db } from './index.ts'

export interface Lease {
  plan: number
  pid: number
  taken_at: string
}

/** A won lease, and the pid it was taken over from. */
export interface Taken extends Lease {
  stole: number | null
}

/** A reused pid must not hold a plan for ever: a lease this old is a dead tick's, whoever answers now. */
const CEILING_MS = 3 * 60 * 60 * 1000

/** One statement, compare-and-swap on the holder judged gone, so a lease refreshed meanwhile is left alone. */
const TAKE = `INSERT INTO leases (plan, pid, taken_at) VALUES (@plan, @pid, @at)
  ON CONFLICT (plan) DO UPDATE SET pid = @pid, taken_at = @at WHERE leases.pid = @gone
  RETURNING plan, pid, taken_at`

export function take(db: Db, plan: number, now: Date = new Date(), pid: number = process.pid): Taken | null {
  const prior = rows(db).find((l) => l.plan === plan)
  const stole = prior !== undefined && gone(prior, now) ? prior.pid : null
  const won = db.prepare(TAKE).get({ plan, pid, at: now.toISOString(), gone: stole ?? 0 }) as Lease | undefined
  return won === undefined ? null : { ...won, stole }
}

export function clear(db: Db, plan: number): void {
  db.prepare('DELETE FROM leases WHERE plan = ?').run(plan)
}

/** The leases a live tick still stands behind; the rest hold nothing. */
export function held(db: Db, now: Date = new Date()): Lease[] {
  return rows(db).filter((l) => !gone(l, now))
}

export function holder(db: Db, plan: number, now: Date = new Date()): Lease | null {
  return held(db, now).find((l) => l.plan === plan) ?? null
}

export function gone(lease: Lease, now: Date): boolean {
  return !alive(lease.pid) || Date.parse(lease.taken_at) <= now.getTime() - CEILING_MS
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a process another user owns, which is a process still.
    return (error as { code?: string }).code === 'EPERM'
  }
}

function rows(db: Db): Lease[] {
  return db.prepare('SELECT plan, pid, taken_at FROM leases ORDER BY plan').all() as Lease[]
}
