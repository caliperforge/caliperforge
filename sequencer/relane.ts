import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { backOn } from '../store/back-on.ts'
import { enable } from '../store/lanes.ts'

/** Switches back on each lane settle turned off once a fix for its stop has landed: the one the director
 * filed, or one whose title names a plan refused alike. */
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
