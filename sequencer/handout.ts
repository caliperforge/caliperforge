import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../rails/diff.ts'

/** The one size threshold (#67): up to this many lines a file is handed whole, past it by the blocks its named lines sit in. */
export const WHOLE = 300

/** A span line of `refusal.md` that names a file: `  - src/x.ts:12 tight.restating`. */
const SPAN = /^\s*[-*]\s*`?([A-Za-z0-9_.-]*\/[A-Za-z0-9_./-]*\.[A-Za-z0-9]+|[A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?::(\d+))?/

const FENCE = '````'

const HEAD = '# The files\n\nThe files this build needs, as your checkout holds them now.'

export interface Handed {
  path: string
  line: number | null
}

/** The text a build is handed: one block per file, a short file whole and a long one by the block each named line sits in. */
export function handout(src: string, files: Handed[]): string {
  const blocks = group(files).flatMap(([path, lines]) => held(src, path, lines))
  return blocks.length === 0 ? '' : [HEAD, ...blocks].join('\n\n')
}

/** What a rebuild is handed: the files its own diff changed and the files the spans of its refusal name. */
export function touched(diff: string, refusal: string): Handed[] {
  return [...parse(diff).map((f) => ({ path: f.path, line: null })), ...spans(refusal)]
}

function spans(refusal: string): Handed[] {
  return refusal.split('\n').flatMap((line) => {
    const span = SPAN.exec(line)
    return span === null ? [] : [{ path: span[1] ?? '', line: span[2] === undefined ? null : Number(span[2]) }]
  })
}

function group(files: Handed[]): [string, number[]][] {
  const out = new Map<string, number[]>()
  for (const file of files) out.set(file.path, [...(out.get(file.path) ?? []), ...(file.line === null ? [] : [file.line])])
  return [...out]
}

function held(src: string, path: string, at: number[]): string[] {
  const full = join(src, path)
  if (!existsSync(full)) return []
  const lines = readFileSync(full, 'utf8').split('\n')
  if (lines.length <= WHOLE) return [block(path, lines, 1, lines.length)]
  if (at.length === 0) return [`## ${path}\n\n${String(lines.length)} lines and no line named: open the part you need.`]
  return [...new Set(at.map((line) => enclosing(lines, line)).map(([from, to]) => block(path, lines, from, to)))]
}

/** A named line's block: from the nearest column-0 line at or above it through the next one, which closes it. */
function enclosing(lines: string[], at: number): [number, number] {
  let from = Math.min(at, lines.length) - 1
  while (from > 0 && !opens(lines[from])) from -= 1
  let to = from + 1
  while (to < lines.length && !opens(lines[to])) to += 1
  return [from + 1, Math.min(to + 1, lines.length)]
}

function opens(line: string | undefined): boolean {
  return line !== undefined && line !== '' && !/^\s/.test(line)
}

function block(path: string, lines: string[], from: number, to: number): string {
  const name = from === 1 && to === lines.length ? path : `${path}:${String(from)}-${String(to)}`
  return `## ${name}\n\n${FENCE}\n${lines.slice(from - 1, to).join('\n')}\n${FENCE}`
}
