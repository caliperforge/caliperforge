import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function planDir(root: string, plan: number): string {
  const dir = join(root, '.cf/plans', String(plan))
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

export function put(root: string, plan: number, name: string, body: string): string {
  const path = join(planDir(root, plan), name)
  writeFileSync(path, body)
  return path
}

export function get(root: string, plan: number, name: string): string {
  return readFileSync(join(planDir(root, plan), name), 'utf8')
}

export function doneIds(issue: string): string[] {
  const ids = [...issue.matchAll(/^\s*[-*]\s*\**(D\d+)\**/gm)].map((m) => m[1] ?? '')
  return ids.length === 0 ? ['D1'] : [...new Set(ids)]
}
