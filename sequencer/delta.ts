import { parse, type FileDiff } from '../rails/diff.ts'

export interface Picked { mode: 'full' | 'delta' | 'comment'; why: string }

const COMMENT = /^(\/\/|\/\*|\*|$)/

/** How a rework round is reviewed: `since` counts only on the builder's `changed` paths, measured against the diff last passed. */
export function classify(passed: string | null, since: string, changed: string[]): Picked {
  if (passed === null) return { mode: 'delta', why: 'no passed diff on file, so against the tree last judged' }
  const seen = parse(passed)
  const counted = parse(since).filter((f) => changed.includes(f.path))
  const unseen = counted.find((f) => !seen.some((s) => s.path === f.path))
  if (unseen !== undefined) return { mode: 'full', why: `${unseen.path} is not in the passed diff` }
  const moved = size(counted)
  const whole = size(seen)
  if (2 * moved > whole) return { mode: 'full', why: `${String(moved)} delta lines is over half of ${String(whole)} passed` }
  if (counted.every(commentOnly)) return { mode: 'comment', why: `${String(moved)} delta lines, comments and docs only` }
  return { mode: 'delta', why: `${String(moved)} delta lines of ${String(whole)} passed, inside the passed diff` }
}

function size(files: FileDiff[]): number {
  return files.reduce((n, f) => n + f.added.length + f.removed.length, 0)
}

function commentOnly(f: FileDiff): boolean {
  return f.path.endsWith('.md') || [...f.added, ...f.removed].every((l) => COMMENT.test(l.text.trim()))
}
