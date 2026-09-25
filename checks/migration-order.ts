import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Check, Finding } from './kind.ts'

/** `actions/checkout` builds a pull request with no `origin/main`, so CI falls back to `HEAD`. */
const REFS = ['refs/remotes/upstream/main', 'refs/remotes/origin/main', 'HEAD']
const MIGRATION = /^\d{4}_.*\.sql$/

export const migrationOrder: Check = {
  name: 'migration-order',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const ref = REFS.find((r) => resolves(root, r))
  if (ref === undefined) return []
  const held = new Set(git(root, ['ls-tree', '--full-tree', '--name-only', ref, '--', 'schema/']).split('\n'))
  const top = Math.max(0, ...[...held].map((p) => p.slice('schema/'.length)).filter((f) => MIGRATION.test(f)).map(number))
  return readdirSync(join(root, 'schema'))
    .filter((f) => MIGRATION.test(f) && !held.has(`schema/${f}`) && number(f) <= top)
    .map((f) => ({
      check: 'migration-order',
      path: `schema/${f}`,
      line: 1,
      message: `migration ${f.slice(0, 4)} is at or below ${String(top).padStart(4, '0')} on ${ref}, so migrate() never applies it`,
    }))
}

function number(name: string): number {
  return Number(name.slice(0, 4))
}

function resolves(cwd: string, ref: string): boolean {
  try {
    git(cwd, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
