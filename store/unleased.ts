import { logged } from './events.ts'
import type { Db } from './index.ts'

export function unleased(db: Db, leased: number[]): number[] {
  const ids = (db.prepare(`UPDATE plans SET state = 'queued', wait_reason = NULL WHERE state = 'running' AND wait_reason = 'leased'
    AND id NOT IN (SELECT value FROM json_each(?)) RETURNING id`).all(JSON.stringify(leased)) as { id: number }[]).map((r) => r.id)
  for (const plan of ids) logged(db, { plan, kind: 'requeue', actor: 'tick', outcome: 'pass', message: 'running with no lease', pointer: null, run: null })
  return ids
}
