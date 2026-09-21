import { dirname, join } from 'node:path'
import { ROSTER, SEED } from '../cli/digests.ts'
import { section, TEST } from './brief.ts'

/** A row a builder owns a path outside the list with: `- <path> — <why>`. */
const OWNED = /^\s*[-*]\s*`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`?\s+(?:—|–|--?)\s+\S/

/**
 * #87: the paths a kernel build touched that its brief's file list does not hold. A test beside a listed
 * file is the builder's to write, and so is a path its handback owns under `## Outside the files` with the
 * reason the ask cannot be met without it: the reviewers judge the reason. A plan with no list is not fenced.
 */
export function strays(touched: string[], listed: string[], handback: string): string[] {
  if (listed.length === 0) return []
  const owned = new Set(section(handback, '## Outside the files').split('\n').flatMap((l) => OWNED.exec(l)?.[1] ?? []))
  return touched.filter((path) => !owned.has(path) && !admits(listed, path))
}

/** A listed path, a test beside one, or a digest file step 3 fills itself. */
function admits(listed: string[], path: string): boolean {
  if (listed.includes(path) || path === ROSTER || path === SEED) return true
  if (!TEST.test(path)) return false
  const dir = dirname(path)
  return listed.some((l) => {
    const tests = join(dirname(l), 'tests')
    return dir === dirname(l) || dir === tests || dir.startsWith(`${tests}/`)
  })
}
