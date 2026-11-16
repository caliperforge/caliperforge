import { logged, pointers } from '../store/events.ts'
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

/** Days without a Greptile post on the fork after which a head is neither asked nor waited on. */
export const SILENT = 14

/** `last` is the fork's newest Greptile post, null when none is in reach, undefined when nothing read it. */
export function silent(db: Db, plan: number, fork: string, at: string, last: string | null | undefined): string | null {
  if (last === undefined || (last !== null && !(Date.now() - Date.parse(last) > SILENT * 86_400_000))) return null
  if (!pointers(db, 'greptile.silent').includes(at)) {
    logged(db, { plan, kind: 'greptile.silent', actor: 'ready', outcome: 'pass', message: fork, pointer: at, run: null })
  }
  return `; no Greptile score: Greptile silent on ${fork} since ${last?.slice(0, 10) ?? 'before its newest 100 comments'}`
}

export function waive(db: Db, root: string, plan: number, by: Holder, why: string): string {
  if (why.trim() === '' || why.includes('\n')) throw new Error('--why takes one non-empty line')
  const sha = headSha(srcDir(root, plan))
  put(root, plan, WAIVED, `${maybe(root, plan, WAIVED) ?? ''}${sha} ${by} ${why}\n`)
  logged(db, { plan, kind: WAIVED, actor: by, outcome: 'pass', message: why, pointer: sha, run: null })
  return sha
}
