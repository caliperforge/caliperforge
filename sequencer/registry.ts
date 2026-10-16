import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registered } from '../runner/rules.ts'
import { git } from './workspace.ts'

export function registry(root: string, at?: string): string[] {
  if (at === undefined) return registered(root).map((path) => readFileSync(join(root, path), 'utf8'))
  return git(root, ['ls-tree', '--name-only', at, 'rules/registry/']).split('\n').filter((path) => path.endsWith('.yaml'))
    .map((path) => git(root, ['show', `${at}:${path}`]))
}
