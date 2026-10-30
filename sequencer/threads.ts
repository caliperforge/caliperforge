import { unresolved, type Read } from '../cli/gh.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { SignalRow } from '../store/signals.ts'
import { BOT } from './capture.ts'

/** A changes-requested review's own open inline comments and the open bot ones, read from the upstream pull request the signal names, never the fork rehearsal. */
export function threads(db: Db, signal: SignalRow, plan: number, read: Read): string {
  if (signal.kind !== 'review' || signal.state !== 'CHANGES_REQUESTED') return ''
  try {
    const rows = unresolved(signal.repo, signal.pr, read).filter((c) => c.review === signal.external_id || BOT.test(c.author))
      .map((c) => `- r${String(c.id)} ${c.author} ${c.path}:${String(c.line)} ${c.body.replace(/\s+/g, ' ').trim()}\n`)
    return rows.length === 0 ? '' : `\ninline:\n${rows.join('')}`
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'review', outcome: 'pass',
      message: error instanceof Error ? error.message : String(error), pointer: null, run: null })
    return ''
  }
}
