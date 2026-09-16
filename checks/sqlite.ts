import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../store/index.ts'

export function fresh(schemaDir: string): Db {
  const db = new Database(':memory:')
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(schemaDir, file), 'utf8'))
  }
  return db
}

export function rejects(db: Db, sql: string): boolean {
  try {
    db.exec(sql)
    return false
  } catch {
    return true
  }
}
