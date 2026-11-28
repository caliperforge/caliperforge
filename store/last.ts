import type { Event } from './events.ts'
import type { Db } from './index.ts'

export function lastOf(db: Db, actor: string, pointer: string): Pick<Event, 'kind' | 'message'> | undefined {
  return db.prepare('SELECT kind, message FROM events WHERE actor = ? AND pointer = ? ORDER BY id DESC LIMIT 1')
    .get(actor, pointer) as Pick<Event, 'kind' | 'message'> | undefined
}
