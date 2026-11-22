import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { cause } from './unpolled.ts'
import { planDir } from './workspace.ts'

/** Set while a sign-off read keeps failing, so a spell of failures logs once. */
const markOf = (root: string, plan: number | null): string =>
  plan === null ? join(root, '.cf/signoff.unread') : join(planDir(root, plan), 'signoff.unread')

/** True for the first failed read of a spell. */
export function unread(root: string, plan: number | null): boolean {
  const mark = markOf(root, plan)
  if (existsSync(mark)) return false
  mkdirSync(dirname(mark), { recursive: true })
  writeFileSync(mark, '')
  return true
}

export function reread(root: string, plan: number | null): void {
  rmSync(markOf(root, plan), { force: true })
}

/** A card that cannot be read stays where it stands; the next tick reads it again. */
export function tried<T>(db: Db, root: string, plan: number, card: () => number | null, read: () => T[]): T[] {
  try {
    const done = read()
    reread(root, plan)
    return done
  } catch (error) {
    const no = card()
    if (unread(root, plan)) {
      logged(db, { plan, kind: 'signoff_unread', actor: 'signoff', outcome: 'refuse', message: cause(error), pointer: no === null ? null : String(no), run: null })
    }
    return []
  }
}
