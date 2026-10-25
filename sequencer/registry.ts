import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dated, SEED } from '../cli/digests.ts'
import { registered } from '../runner/rules.ts'
import { git, tried } from './workspace.ts'

export function registry(root: string, at?: string): { path: string; text: string }[] {
  if (at === undefined) return registered(root).map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
  return git(root, ['ls-tree', '--name-only', at, 'rules/registry/']).split('\n').filter((path) => path.endsWith('.yaml'))
    .map((path) => ({ path, text: git(root, ['show', `${at}:${path}`]) }))
}

export function added(root: string, at?: string): Map<string, string> {
  if (at !== undefined) return dated(tried(root, ['show', `${at}:${SEED}`]) ?? '')
  const seed = join(root, SEED)
  return dated(existsSync(seed) ? readFileSync(seed, 'utf8') : '')
}
