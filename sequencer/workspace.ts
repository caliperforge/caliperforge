import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The plan's scratch checkout, at `.cf/work/<id>`.
 *
 * `runner/packet.ts:admits()` refuses any reviewer cwd carrying a `plans/`
 * path segment. That rule targets the org's own `plans/`; it cannot tell the
 * two apart. The earlier name `.cf/plans/<id>` tripped it on every review.
 */
export function planDir(root: string, plan: number): string {
  return join(root, '.cf/work', String(plan))
}

export function srcDir(root: string, plan: number): string {
  const dir = join(planDir(root, plan), 'src')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function put(root: string, plan: number, name: string, body: string): string {
  const dir = planDir(root, plan)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

export function get(root: string, plan: number, name: string): string {
  return readFileSync(join(planDir(root, plan), name), 'utf8')
}

export function maybe(root: string, plan: number, name: string): string | null {
  const path = join(planDir(root, plan), name)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

export function doneIds(issue: string): string[] {
  const ids = [...issue.matchAll(/^\s*[-*]\s*\**(D\d+)\**/gm)].map((m) => m[1] ?? '')
  return ids.length === 0 ? ['D1'] : [...new Set(ids)]
}
