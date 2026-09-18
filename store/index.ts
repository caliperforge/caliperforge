import Database from 'better-sqlite3'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuleRow } from './rows.ts'

export type Db = Database.Database

interface Obj {
  type: string
  name: string
  sql: string
}

export function open(path: string): Db {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  return db
}

/**
 * One file, one transaction: a schema file that throws half way leaves `user_version` and every
 * table as they were. The foreign-key switch is thrown outside it -- sqlite makes `PRAGMA
 * foreign_keys` a no-op inside a transaction, and a file that rebuilds a table needs it off.
 */
export function migrate(db: Db, dir: string): string[] {
  const at = Number(db.pragma('user_version', { simple: true }))
  const pending = readdirSync(dir).filter((f) => f.endsWith('.sql') && version(f) > at).sort()
  const keys = Number(db.pragma('foreign_keys', { simple: true })) === 1
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8')
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(sql)
        db.pragma(`user_version = ${String(version(file))}`)
      })()
    } finally {
      if (keys) db.pragma('foreign_keys = ON')
    }
  }
  return pending
}

export function dump(db: Db, out: string): void {
  const objects = db
    .prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid')
    .all() as Obj[]
  const body = objects.map((o) => `${o.sql};`)
  const tables = objects.filter((o) => o.type === 'table').flatMap((o) => inserts(db, o.name))
  const at = String(db.pragma('user_version', { simple: true }))
  writeFileSync(out, `PRAGMA foreign_keys = OFF;\nBEGIN;\n${[...body, ...tables].join('\n')}\nCOMMIT;\nPRAGMA user_version = ${at};\n`)
}

export function rules(db: Db): RuleRow[] {
  return db.prepare('SELECT * FROM rules ORDER BY id').all().map((r) => RuleRow.parse(r))
}

function version(file: string): number {
  return Number(file.slice(0, 4))
}

function inserts(db: Db, table: string): string[] {
  const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]
  return rows.map((r) => `INSERT INTO "${table}" VALUES (${Object.values(r).map(literal).join(', ')});`)
}

function literal(v: unknown): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`
  throw new TypeError('sqlite returned a column type the dump cannot write')
}
