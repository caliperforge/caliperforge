import type { Db } from '../store/index.ts'
import { partsOf } from '../store/parts.ts'
import { builderRan } from '../store/plans.ts'
import { PARENT } from './parent.ts'
import { own } from './reroute.ts'
import { diffOf, put } from './workspace.ts'

/** A split parent's builder diff, kept in its folder and in that of its first part that is not a measure part. */
export function bequeathed(db: Db, root: string, parent: number): void {
  const diff = builderRan(db, parent) ? diffOf(root, parent) : ''
  if (diff.trim() === '') return
  put(root, parent, PARENT, diff)
  const first = partsOf(db, parent).find((p) => !own(p.body))?.plan
  if (first !== null && first !== undefined) put(root, first, PARENT, diff)
}
