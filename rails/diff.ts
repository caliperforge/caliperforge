export interface Line {
  path: string
  line: number
  text: string
}

export interface FileDiff {
  path: string
  deleted: boolean
  added: Line[]
  removed: Line[]
}

const GONE = '/dev/null'
const FROM = /^--- (?:a\/)?(.+?)\s*$/
const HEADER = /^\+\+\+ (?:b\/)?(.+?)\s*$/
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parse(diff: string): FileDiff[] {
  const lines = diff.split('\n')
  const files = new Map<string, FileDiff>()
  let at: FileDiff | undefined
  let cursor = 0
  let from = GONE
  for (const [index, raw] of lines.entries()) {
    if (heads(lines, index)) {
      if (raw.startsWith('--- ')) from = FROM.exec(raw)?.[1] ?? GONE
      else at = opened(files, HEADER.exec(raw)?.[1] ?? GONE, from)
      continue
    }
    const hunk = HUNK.exec(raw)
    if (hunk !== null) cursor = Number(hunk[2]) === 0 ? Number(hunk[1]) : Number(hunk[2])
    else if (at !== undefined) cursor = consume(at, raw, cursor)
  }
  return [...files.values()].filter((f) => f.path !== GONE)
}

function heads(lines: string[], index: number): boolean {
  const raw = lines[index] ?? ''
  if (raw.startsWith('--- ')) return (lines[index + 1] ?? '').startsWith('+++ ')
  if (raw.startsWith('+++ ')) return (lines[index - 1] ?? '').startsWith('--- ')
  return false
}

function opened(files: Map<string, FileDiff>, to: string, from: string): FileDiff {
  const deleted = to === GONE
  const path = deleted ? from : to
  const at = files.get(path) ?? { path, deleted, added: [], removed: [] }
  files.set(path, at)
  return at
}

function consume(at: FileDiff, raw: string, cursor: number): number {
  if (raw.startsWith('+')) {
    at.added.push({ path: at.path, line: cursor, text: raw.slice(1) })
    return cursor + 1
  }
  if (raw.startsWith('-')) {
    at.removed.push({ path: at.path, line: cursor, text: raw.slice(1) })
    return cursor
  }
  return raw.startsWith(' ') ? cursor + 1 : cursor
}
