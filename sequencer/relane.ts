import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { backOn, enable } from '../store/lanes.ts'

/** Switches back on each lane settle turned off once the fix the director filed for its stop has landed. */
export function relane(db: Db): void {
  for (const row of backOn(db)) {
    const sha = (row.evidence.split('/').pop() ?? '').slice(0, 12)
    db.transaction(() => {
      enable(db, row.pipe, true)
      logged(db, { plan: row.plan, kind: 'pipe', actor: 'tick', outcome: 'pass',
        message: `${row.name} on: fix for ${row.origin} landed as ${sha}`, pointer: row.origin, run: null })
    })()
  }
}
