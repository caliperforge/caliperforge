import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { rules, type Db } from '../store/index.ts'
import type { Check, Finding } from './kind.ts'
import { fresh } from './sqlite.ts'
import { walk } from './tree.ts'

export const ruleHashes: Check = {
  name: 'rule-hashes',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const db = fresh(join(root, 'schema'))
  const seed = join(root, 'rules.seed.sql')
  if (existsSync(seed)) db.exec(readFileSync(seed, 'utf8'))
  else load(db, root)
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

function load(db: Db, root: string): void {
  const insert = db.prepare('INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES (?, ?, ?, ?, ?)')
  const today = new Date().toISOString().slice(0, 10)
  for (const path of files(root)) insert.run(path, kind(path), path, hash(join(root, path)), today)
}

function files(root: string): string[] {
  return walk(join(root, 'rules'), () => true).map((p) => relative(root, p))
}

function kind(path: string): string {
  if (path.endsWith('roster.yaml')) return 'roster'
  if (path.endsWith('rails.yaml')) return 'rail'
  return 'card'
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function finding(path: string, message: string): Finding {
  return { check: 'rule-hashes', path, line: 1, message }
}
