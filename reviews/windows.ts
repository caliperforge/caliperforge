import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { block } from '../sequencer/handout.ts'
import type { Changed } from './package.ts'

const AROUND = 30
const CAP = 300

export function windows(repo: string, path: string, hunks: Set<number>): Changed {
  const lines = readFileSync(join(repo, path), 'utf8').split('\n')
  const spans: [number, number][] = []
  for (const n of [...hunks].sort((a, b) => a - b)) {
    const [from, to] = [Math.max(1, n - AROUND), Math.min(lines.length, n + AROUND)]
    const last = spans.at(-1)
    if (last !== undefined && from <= last[1] + 1) last[1] = to
    else spans.push([from, to])
  }
  const blocks: string[] = []
  let left = CAP
  for (const [from, to] of spans) {
    if (left <= 0) break
    const end = Math.min(to, from + left - 1)
    blocks.push(block(path, lines, from, end))
    left -= end - from + 1
  }
  return { path, blocks, names: new Set() }
}
