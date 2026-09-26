import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAP, ROSTER, SEED } from '../cli/digests.ts'
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
  if (listed.includes(path) || path === ROSTER || path === SEED || path === MAP) return true
  if (!TEST.test(path)) return false
  const dir = dirname(path)
  return listed.some((l) => {
    const tests = join(dirname(l), 'tests')
    return dir === dirname(l) || dir === tests || dir.startsWith(`${tests}/`)
  })
}

/** A row a builder names a file for deletion with: `- <path>`, with or without a reason after it. */
const GONE = /^\s*[-*]\s*`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`?\s*(?:(?:—|–|--?)\s+\S.*)?$/

/**
 * #64: the paths a build says to remove. A builder holds Read, Write, Edit, Glob and Grep and no
 * shell, so a build that should drop a file can only empty it; it names the paths here instead and
 * the kernel does the removing. Named twice is named once.
 */
export function deletions(handback: string): string[] {
  return [...new Set(section(handback, '## Deleted').split('\n').flatMap((l) => GONE.exec(l)?.[1] ?? []))]
}

/** A migration a diff creates: `--- /dev/null` over `+++ b/schema/NNNN_*.sql`. */
const MADE = /^--- \/dev\/null\n\+\+\+ b\/(schema\/(\d{4})_[^\n/]*\.sql)$/gm

/**
 * A migration the build created, numbered at or below one the checkout already holds. `migrate` applies only
 * what is above the store's `user_version`, so the live store would never run it: plan 46 (#52) built a 0018
 * on a base that already had 0021.
 */
export function renumbered(src: string, diff: string): string[] {
  const made = [...diff.matchAll(MADE)].map((m) => ({ path: String(m[1]), n: Number(m[2]) }))
  const dir = join(src, 'schema')
  if (made.length === 0 || !existsSync(dir)) return []
  const mine = new Set(made.map((m) => m.path))
  const held = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && !mine.has(`schema/${f}`)).map((f) => Number(f.slice(0, 4)))
  const top = Math.max(0, ...held)
  return made.filter((m) => m.n <= top).map((m) => m.path)
}
