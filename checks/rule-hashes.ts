import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { rules } from '../store/index.ts'
import type { Check, Finding } from './kind.ts'
import { fresh } from './sqlite.ts'
import { walk } from './tree.ts'

export const ruleHashes: Check = {
  name: 'rule-hashes',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const seed = join(root, 'rules.seed.sql')
  if (!existsSync(seed)) return [finding('rules.seed.sql', 'no recorded hashes to compare the tree against')]
  const db = fresh(join(root, 'schema'))
  db.exec(readFileSync(seed, 'utf8'))
  const onDisk = new Map(files(root).map((p) => [p, hash(join(root, p))]))
  const rows = rules(db)
  return [...drift(rows, onDisk), ...unhashed(rows, onDisk)]
}

function drift(rows: { path: string; content_hash: string }[], onDisk: Map<string, string>): Finding[] {
  return rows.flatMap((row) => {
    const actual = onDisk.get(row.path)
    if (actual === undefined) return [finding(row.path, 'row path names no file')]
    if (actual !== row.content_hash) return [finding(row.path, 'row hash is stale')]
    return []
  })
}

function unhashed(rows: { path: string }[], onDisk: Map<string, string>): Finding[] {
  const known = new Set(rows.map((r) => r.path))
  return [...onDisk.keys()].filter((p) => !known.has(p)).map((p) => finding(p, 'file under rules/ has no row'))
}

function files(root: string): string[] {
  return walk(join(root, 'rules'), () => true).map((p) => relative(root, p))
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function finding(path: string, message: string): Finding {
  return { check: 'rule-hashes', path, line: 1, message }
}
