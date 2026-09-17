export interface Line {
  path: string
  line: number
  text: string
}

export interface FileDiff {
  path: string
  added: Line[]
  removed: Line[]
}

const HEADER = /^\+\+\+ (?:b\/)?(.+?)\s*$/
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parse(diff: string): FileDiff[] {
  const files = new Map<string, FileDiff>()
  let at: FileDiff | undefined
  let cursor = 0
  for (const raw of diff.split('\n')) {
    const path = HEADER.exec(raw)?.[1]
    if (path !== undefined) {
      at = files.get(path) ?? { path, added: [], removed: [] }
      files.set(path, at)
      continue
    }
    const start = HUNK.exec(raw)?.[1]
    if (start !== undefined) cursor = Number(start)
    else if (at !== undefined) cursor = consume(at, raw, cursor)
  }
  return [...files.values()].filter((f) => f.path !== '/dev/null')
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
