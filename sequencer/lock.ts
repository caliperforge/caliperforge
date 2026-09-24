import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gone, type Lease } from '../store/leases.ts'

const LOCK = '.cf/checks.lock'

/** One step 3 test run on the host at a time: null when this tick holds the lock, else the live holder's lease. */
export function lock(root: string, plan: number, now: Date = new Date()): Lease | null {
  const holder = claim(join(root, LOCK), plan, now)
  if (holder === null || !gone(holder, now)) return holder
  unlock(root)
  return claim(join(root, LOCK), plan, now)
}

export function unlock(root: string): void {
  rmSync(join(root, LOCK), { force: true })
}

function claim(path: string, plan: number, now: Date): Lease | null {
  try {
    writeFileSync(path, JSON.stringify({ plan, pid: process.pid, taken_at: now.toISOString() }), { flag: 'wx' })
    return null
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    return JSON.parse(readFileSync(path, 'utf8')) as Lease
  }
}
