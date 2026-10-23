import { join, relative } from 'node:path'
import { cloned, maybe, srcDir, tried } from './workspace.ts'

/** Without `cloned`, git in an un-cloned `src` walks up into the machine's own repo. */
export function committed(root: string, plan: number, path: string): boolean {
  const src = srcDir(root, plan)
  const rel = relative(src, join(src, path))
  const base = maybe(root, plan, 'base.sha')?.trim() ?? ''
  return !rel.startsWith('..') && base !== '' && cloned(src) && tried(src, ['cat-file', '-e', `${base}:${rel}`]) !== null
}
