import type { Event } from './events.ts'
import type { Db } from './index.ts'

export function lastLogged(db: Db, kind: string, pointer: string): (Pick<Event, 'outcome'> & { at: string }) | undefined {
  return db.prepare(`SELECT outcome, strftime('%Y-%m-%dT%H:%M:%SZ', at) AS at FROM events WHERE kind = ? AND pointer = ?
    ORDER BY id DESC LIMIT 1`).get(kind, pointer) as (Pick<Event, 'outcome'> & { at: string }) | undefined
}
