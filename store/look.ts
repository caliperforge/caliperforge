import Database from 'better-sqlite3'

const ROWS = 200

export function select(path: string, sql: string): unknown[] {
  if (/\bsettings\b/i.test(sql)) throw new Error('cf look store never reads settings')
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const statement = db.prepare(sql)
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
