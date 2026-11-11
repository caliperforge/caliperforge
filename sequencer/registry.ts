import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { dated, SEED } from '../cli/digests.ts'
import { registered } from '../runner/rules.ts'
import { git, tried } from './workspace.ts'

export function registry(root: string, at?: string): { path: string; text: string }[] {
  const files = at === undefined
    ? registered(root).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
    : git(root, ['ls-tree', '--name-only', at, 'rules/registry/']).split('\n').filter((path) => path.endsWith('.yaml'))
      .map((path) => ({ path, text: git(root, ['show', `${at}:${path}`]) }))
  unique(files)
  return files
}

function unique(files: { path: string; text: string }[]): void {
  const seen = new Map<string, string>()
  const keyed = files.flatMap(({ path, text }) => (parse(text) as { name: string; table?: string; column?: string; where?: string }[])
    .flatMap((line) => [`name ${line.name}`, ...line.table === undefined ? []
      : [`${line.table}.${String(line.column)} WHERE ${(line.where ?? '').replace(/\s+/g, ' ').trim()}`]].map((key) => ({ path, key }))))
  for (const { path, key } of keyed) {
    const first = seen.get(key)
    if (first !== undefined) throw new Error(`${first} and ${path} both register ${key}`)
    seen.set(key, path)
  }
}

export function added(root: string, at?: string): Map<string, string> {
  if (at !== undefined) return dated(tried(root, ['show', `${at}:${SEED}`]) ?? '')
  const seed = join(root, SEED)
  return dated(existsSync(seed) ? readFileSync(seed, 'utf8') : '')
}
