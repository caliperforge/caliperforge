import Database from 'better-sqlite3'

const ROWS = 200

export function select(path: string, sql: string): unknown[] {
  if (/\bsettings\b/i.test(sql)) throw new Error('cf look store never reads settings')
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const statement = prepared(db, sql)
    if (!statement.reader || !statement.readonly) throw new Error('cf look store runs one SELECT')
    const rows: unknown[] = []
    for (const row of statement.iterate()) {
      rows.push(row)
      if (rows.length === ROWS) break
    }
    return rows
  } finally {
    db.close()
  }
}

function prepared(db: Database.Database, sql: string): Database.Statement {
  try {
    return db.prepare(sql)
  } catch (error) {
    const message = (error as Error).message
    if (!/^no such (column|table)/.test(message)) throw error
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%' AND name <> 'settings' ORDER BY rowid`).pluck().all() as string[]
    const lines = message.startsWith('no such table')
      ? [`tables: ${tables.join(', ')}`]
      : tables.filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(sql))
        .map((name) => `${name}: ${(db.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name).join(', ')}`)
    throw new Error([message, ...lines].join('\n'), { cause: error })
  }
}
