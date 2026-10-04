import { logged, pointers } from '../store/events.ts'
import type { Db } from '../store/index.ts'

export const GONE = /Could not resolve to a PullRequest|HTTP 404/

export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
}

export function gone(db: Db, plan: number, pointer: string, error: unknown): boolean {
  const message = firstLine(error)
  if (!GONE.test(message)) return false
  logged(db, { plan, kind: 'gone', actor: 'gh', outcome: 'pass', message, pointer, run: null })
  return true
}

export function closed(db: Db, plan: number, pointer: string, state: string): void {
  if (state !== 'OPEN') logged(db, { plan, kind: 'gone', actor: 'reachable', outcome: 'pass', message: state, pointer, run: null })
}

export function polled(db: Db): (row: { evidence: string }) => boolean {
  const off = new Set(pointers(db, 'gone'))
  return (row) => !off.has(row.evidence)
}
