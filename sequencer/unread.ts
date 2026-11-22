import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged, type Event } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { cause } from './unpolled.ts'
import { planDir } from './workspace.ts'

/** Set while a sign-off read keeps failing, so a spell of failures logs once. */
const markOf = (root: string, plan: number | null): string =>
  plan === null ? join(root, '.cf/signoff.unread') : join(planDir(root, plan), 'signoff.unread')

/** A read that throws logs `signoff_unread` on the first failure of a spell and returns nothing; a good read ends the spell. */
export function unread<T>(db: Db, root: string, plan: number | null, read: () => T[], event: (error: unknown) => Pick<Event, 'actor' | 'message' | 'pointer'>): T[] {
  const mark = markOf(root, plan)
  try {
    const done = read()
    rmSync(mark, { force: true })
    return done
  } catch (error) {
    const e = event(error)
    if (existsSync(mark)) return []
    mkdirSync(dirname(mark), { recursive: true })
    writeFileSync(mark, '')
    logged(db, { ...e, plan, kind: 'signoff_unread', outcome: 'refuse', run: null })
    return []
  }
}

/** A card that cannot be read stays where it stands; the next tick reads it again. */
export function tried<T>(db: Db, root: string, plan: number, card: () => number | null, read: () => T[]): T[] {
  return unread(db, root, plan, read, (error) => {
    const no = card()
    return { actor: 'signoff', message: cause(error), pointer: no === null ? null : String(no) }
  })
}
