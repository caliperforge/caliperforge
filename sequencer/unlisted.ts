import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { lastOf } from '../store/last.ts'
import { cause, firstLine } from './unpolled.ts'

const OFF = ': issues are turned off'

export function unlisted(repo: string, error: unknown): string {
  return cause(error).includes('has disabled issues') ? `${repo}${OFF}` : `${repo}: ${firstLine(error)}`
}

/** A home stays read every tick; while its failure stays issues-off, or stays anything else, it is logged once. */
export function ongoing(db: Db, repo: string, line: string): boolean {
  const last = lastOf(db, 'intake', repo)
  return last?.kind === 'swallowed' && last.message.endsWith(OFF) === line.endsWith(OFF)
}

export function relisted(db: Db, repo: string): void {
  if (lastOf(db, 'intake', repo)?.kind !== 'swallowed') return
  logged(db, { plan: null, kind: 'back', actor: 'intake', outcome: 'pass', message: repo, pointer: repo, run: null })
}
