import { join } from 'node:path'
import { cloned, drop, maybe, planDir, put, tried } from './workspace.ts'

export const CUT = 'a cut moves only through a Base: line in ask.md'

/** `--is-ancestor` fails both on a commit HEAD does not contain and on one the clone never fetched. */
export function moved(root: string, plan: number, was: string | null): boolean {
  const sha = maybe(root, plan, 'base.sha')
  if (sha === was) return false
  const src = join(planDir(root, plan), 'src')
  if (sha !== null && cloned(src) && tried(src, ['merge-base', '--is-ancestor', sha.trim(), 'HEAD']) !== null) return false
  if (was === null) drop(root, plan, 'base.sha')
  else put(root, plan, 'base.sha', was)
  return true
}
