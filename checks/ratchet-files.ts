import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Counts } from './ratchet.ts'
import { walk } from './tree.ts'

const FILE = 'ratchet.json'

/** The deepest ratchet file whose folder holds `path`, the one `budgets` lets win. */
function homeOf(path: string, files: string[]): string {
  return files.filter((file) => path.startsWith(file.slice(0, -FILE.length))).sort((a, b) => b.length - a.length)[0] ?? FILE
}

export function write(root: string, rows: Counts): string[] {
  const files = walk(root, (name) => name === FILE).map((file) => file.slice(root.length + 1))
  const sorted = Object.keys(rows).sort()
  const written = [...new Set([FILE, ...files])].sort()
  for (const file of written) {
    const folder = file.slice(0, -FILE.length)
    const own = sorted.filter((path) => homeOf(path, files) === file).map((path) => [path.slice(folder.length), rows[path]])
    writeFileSync(join(root, file), `${JSON.stringify(Object.fromEntries(own), null, 2)}\n`)
  }
  return written
}
