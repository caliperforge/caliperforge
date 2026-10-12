import { readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

export function held(root: string, dates: string[], landed: number[], ref: string): boolean {
  const date = /^learnings:(\d{4}-\d{2}-\d{2})$/.exec(ref)?.[1]
  if (date !== undefined) return dates.includes(date)
  const plan = /^landed:(\d+)$/.exec(ref)?.[1]
  if (plan !== undefined) return landed.includes(Number(plan))
  const [, path, line] = /^(.+):([1-9]\d*)$/.exec(ref) ?? []
  if (path === undefined || line === undefined) return false
  const file = resolve(root, path)
  if (relative(root, file).startsWith('..') || statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false
  return readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').length >= Number(line)
}
