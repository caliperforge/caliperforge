import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'fixtures'])

export function walk(dir: string, match: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path, match))
    else if (match(entry.name)) out.push(path)
  }
  return out
}

export function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
}

export function lineOf(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length
}
