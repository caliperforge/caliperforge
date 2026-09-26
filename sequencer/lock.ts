import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gone, type Lease } from '../store/leases.ts'

const LOCK = '.cf/checks.lock'

/** More than any host sets; `unlock` looks this far so a lowered width still frees what a wider one took. */
const MOST = 8

/**
 * Step 3 test runs on the host at once: `CF_CHECK_SLOTS` of them, one when unset. It was one outright, so the
 * slots of #308 never saw a second run: on 09-25 two jobs sat behind one suite for ten minutes, a tick apiece.
 * Null when this job holds a place, else a live holder's lease.
 */
export function lock(root: string, plan: number, now: Date = new Date(), width = widthOf()): Lease | null {
  let first: Lease | null = null
  for (const path of places(root, width)) {
    let holder = claim(path, plan, now)
    if (holder !== null && gone(holder, now)) {
      rmSync(path, { force: true })
      holder = claim(path, plan, now)
    }
    if (holder === null) return null
    first ??= holder
  }
  return first
}

export function unlock(root: string, plan: number): void {
  for (const path of places(root, MOST)) if (holderOf(path)?.plan === plan) rmSync(path, { force: true })
}

function widthOf(): number {
  return Math.max(1, Number(process.env.CF_CHECK_SLOTS ?? 1) || 1)
}

function places(root: string, n: number): string[] {
  return [...Array(Math.min(n, MOST)).keys()].map((i) => join(root, i === 0 ? LOCK : `${LOCK}.${String(i)}`))
}

function holderOf(path: string): Lease | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Lease
  } catch {
    return null
  }
}

function claim(path: string, plan: number, now: Date): Lease | null {
  try {
    writeFileSync(path, JSON.stringify({ plan, pid: process.pid, taken_at: now.toISOString() }), { flag: 'wx' })
    return null
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    // a file caught mid-write is a place just taken
    return holderOf(path) ?? { plan: -1, pid: process.pid, taken_at: now.toISOString() }
  }
}
