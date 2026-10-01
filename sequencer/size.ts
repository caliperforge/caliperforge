import { parse, type FileDiff } from '../rails/diff.ts'
import { TEST_FILE } from '../rails/test-weakened/index.ts'
import type { Db } from '../store/index.ts'
import { count } from '../store/lanes.ts'
import type { Check, Row } from './card.ts'
import { TEST } from './route.ts'
import { diffOf } from './workspace.ts'

const GENERATED =/(^|\/)generated\/|(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

const FN =/^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|func|def|function)\b/

const linesOf = (file: FileDiff): number => file.added.length + file.removed.length

const sum = (files: FileDiff[]): number => files.reduce((n, f) => n + linesOf(f), 0)

export function sized(diff: string, limit: number): Row {
  const files = parse(diff)
  const code = files.filter((f) => !TEST.test(f.path) && !TEST_FILE.test(f.path) && !GENERATED.test(f.path))
  const head = `${String(sum(code))} code lines (${String(sum(files))} in all)`
  if (sum(code) <= limit) return { check: 'size', ok: true, says: `${head}, limit ${String(limit)}` }
  return { check: 'size', ok: false, says: `${head}, over ${String(limit)}: ${cut(code, limit)}` }
}

function cut(code: FileDiff[], limit: number): string {
  let running = 0
  let last = ''
  for (const file of code) {
    if (running + linesOf(file) > limit) return last === '' ? within(file, limit) : `cut after ${last} (${String(running)} lines)`
    running += linesOf(file)
    last = file.path
  }
  return `cut after ${last} (${String(running)} lines)`
}

function within(file: FileDiff, limit: number): string {
  const opens = file.added.slice(1, limit).filter((l) => FN.test(l.text)).at(-1)
  return opens === undefined
    ? `no cut under ${String(limit)}: ${file.path} alone is ${String(linesOf(file))} lines`
    : `cut before ${file.path}:${String(opens.line)}`
}

export function size(repo: string): Check {
  return (db, root, plan) => sized(diffOf(root, plan), limitOf(db, repo))
}

export function limitOf(db: Db, repo: string): number {
  const row = db.prepare('SELECT lines FROM size_limits WHERE repo = ?').get(repo) as { lines: number } | undefined
  return row?.lines ?? count(db, 'card.size_limit')
}
