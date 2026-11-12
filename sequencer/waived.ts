import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Holder } from '../store/plans.ts'
import { headSha, maybe, put, srcDir } from './workspace.ts'

export const WAIVED = 'greptile.waived'

export function waived(root: string, plan: number, sha: string): string | null {
  const line = (maybe(root, plan, WAIVED) ?? '').split('\n').findLast((l) => l.split(' ')[0] === sha)
  if (line === undefined) return null
  const [, by, ...why] = line.split(' ')
  return `waived at ${sha.slice(0, 12)} by ${by ?? ''}: ${why.join(' ')}`
}

export function waive(db: Db, root: string, plan: number, by: Holder, why: string): string {
  if (why.trim() === '' || why.includes('\n')) throw new Error('--why takes one non-empty line')
  const sha = headSha(srcDir(root, plan))
  put(root, plan, WAIVED, `${maybe(root, plan, WAIVED) ?? ''}${sha} ${by} ${why}\n`)
  logged(db, { plan, kind: WAIVED, actor: by, outcome: 'pass', message: why, pointer: sha, run: null })
  return sha
}
