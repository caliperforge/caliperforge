import type { FileDiff, Line } from '../diff.ts'
import { titleOf } from './index.ts'

type Linked = (prev: Line, next: Line) => boolean

const SKIPPED = /\bx?(?:test|it|describe)(?:\.(?:skip|todo|failing))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1/
const DEFINED = /\b(?:fn|func|fun|def|function)\s+(\w+)/
const ATTRIBUTE = /^\s*[#@]/

export function moved(file: FileDiff, skip: RegExp): (line: Line) => boolean {
  const base = new Set(keyed(file.removed, skip, (a, b) => a.line === b.line).values())
  const added = keyed(file.added, skip, (a, b) => a.line + 1 === b.line)
  return (line) => {
    const key = added.get(line)
    return key !== undefined && base.has(key)
  }
}

function keyed(lines: Line[], skip: RegExp, linked: Linked): Map<Line, string> {
  const runs: Line[][] = []
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    if (prev !== undefined && linked(prev, l)) runs.at(-1)?.push(l)
    else runs.push([l])
  })
  return new Map(runs.flatMap((run) => run.flatMap((l, i): [Line, string][] => {
    if (!skip.test(l.text)) return []
    const title = titleOf(l.text, SKIPPED) ?? named(ATTRIBUTE.test(l.text) ? run.slice(i + 1) : run.slice(0, i).reverse())
    return title === undefined ? [] : [[l, `${title}\n${l.text.trim()}`]]
  })))
}

function named(lines: Line[]): string | undefined {
  return lines.map((l) => DEFINED.exec(l.text)?.[1]).find((t) => t !== undefined)
}
