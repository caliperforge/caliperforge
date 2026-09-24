import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Past this many lines the handover is the repository again, and the reviewer is better served by the diff alone. */
const CAP = 1500

/** A file whose enclosing functions run past this is handed with a fixed margin instead, then with the plain hunks. */
const PER_FILE = 300

const WIDTHS = ['--function-context', '-U25', '-U3']

const DIRS = 6

const PER_DIR = 25

const COMMENT = /^\s*(\/\/+!?|\/\*+|\*|#+|--(\[\[)?|;+|"""|'''|<!--)\s*/

/** Comment lines that are pragmas, not descriptions. */
const PRAGMA = /^(frozen_string_literal|luacheck|eslint|@ts-|SPDX|-\*-|coding[:=]|!)/

export interface Handover {
  context?: string
  map?: string
}

/**
 * #132. What a reviewer of someone else's repository needs so it does not open files to find its
 * footing: each change inside the function that encloses it, and the files that sit beside it.
 */
export function handover(src: string, base: string): Handover {
  const context = enclosed(src, base)
  const map = around(src, base)
  return { ...(context === null ? {} : { context }), ...(map === '' ? {} : { map }) }
}

export function enclosed(src: string, base: string): string | null {
  const parts: string[] = []
  let used = 0
  for (const path of changedPaths(src, base)) {
    const part = fitted(src, base, path)
    if (part === undefined || used + part.split('\n').length > CAP) continue
    parts.push(part)
    used += part.split('\n').length
  }
  return parts.length === 0 ? null : parts.join('')
}

function fitted(src: string, base: string, path: string): string | undefined {
  for (const w of WIDTHS) {
    const out = git(src, ['diff', w, base, '--', path])
    if (out.split('\n').length <= PER_FILE) return out
  }
  return undefined
}

function changedPaths(src: string, base: string): string[] {
  return git(src, ['diff', '--name-only', base]).split('\n').filter((p) => p !== '')
}

function around(src: string, base: string): string {
  const changed = new Set(changedPaths(src, base))
  const dirs = [...new Set([...changed].map((p) => dirname(p)))].slice(0, DIRS)
  const tracked = git(src, ['ls-files']).split('\n').filter((p) => p !== '')
  return dirs.map((dir) => {
    const here = tracked.filter((p) => dirname(p) === dir)
    const rows = here.slice(0, PER_DIR).map((p) => row(src, p, changed.has(p)))
    const more = here.length > PER_DIR ? [`  … ${String(here.length - PER_DIR)} more`] : []
    return [`${dir === '.' ? '(root)' : dir}/`, ...rows, ...more].join('\n')
  }).join('\n\n')
}

function row(src: string, path: string, changed: boolean): string {
  const lines = readFileSync(join(src, path), 'utf8').split('\n')
  const head = described(lines.slice(0, 15))
  const note = head === null ? '' : ` — ${head.slice(0, 100)}`
  const count = lines.at(-1) === '' ? lines.length - 1 : lines.length
  return `  ${changed ? '*' : ' '} ${path.split('/').at(-1) ?? path}  ${String(count)} lines${note}`
}

/** The first comment that says something, reading into a block comment whose opener stands alone. */
function described(lines: string[]): string | null {
  let open = false
  for (const line of lines) {
    const marked = COMMENT.test(line)
    if (!marked && !open) continue
    const text = line.replace(COMMENT, '').replace(/\*\/\s*$|\]\]\s*$/, '').trim()
    if (text === '' || line.startsWith('#!')) {
      open = marked
      continue
    }
    if (!PRAGMA.test(text)) return text
    open = false
  }
  return null
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
