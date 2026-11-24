import type { Db } from '../store/index.ts'
import { partsOf } from '../store/parts.ts'
import { builderRan } from '../store/plans.ts'
import { PARENT } from './parent.ts'
import { own } from './reroute.ts'
import { diffOf, maybe, put } from './workspace.ts'

/** A split parent's builder diff, kept in its folder for its first part that is not a measure part. */
export function bequeathed(db: Db, root: string, parent: number): void {
  const diff = builderRan(db, parent) ? diffOf(root, parent) : ''
  if (diff.trim() !== '') put(root, parent, PARENT, diff)
}

/** Part `n`'s plan `id`, given the parent's diff when `n` is the parent's first part that is not a measure part. */
export function inheritedBy(db: Db, root: string, parent: number, n: number, id: number): number {
  const diff = maybe(root, parent, PARENT)
  if (diff !== null && partsOf(db, parent).find((p) => !own(p.body))?.n === n) put(root, id, PARENT, diff)
  return id
}
