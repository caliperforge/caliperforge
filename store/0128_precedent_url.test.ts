import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const at0127 = () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0127-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0128')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  return db
}

it('D1 0128 empties the precedent rows 0127 held', () => {
  const db = at0127()
  db.prepare(`INSERT INTO precedent_sources (repo, number, title, merged_at, merger, files, issues)
    VALUES ('o/r', 7, 't', '2026-10-07T00:00:00Z', NULL, '[]', '[]')`).run()
  db.prepare(`INSERT INTO precedent_threads (repo, number, kind, author, role, text, path, line)
    VALUES ('o/r', 7, 'review', 'x', 'contributor', 'why', NULL, NULL)`).run()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0128_precedent_url.sql', '0129_precedent_rows.sql', '0130_precedent_open.sql', '0131_openings.sql', '0132_escapes.sql', '0133_precedent_findings.sql'])
  expect(db.prepare('SELECT count(*) FROM precedent_sources').pluck().get()).toBe(0)
  expect(db.prepare('SELECT count(*) FROM precedent_threads').pluck().get()).toBe(0)
})

it('D4 a thread row without url fails on NOT NULL', () => {
  const db = at0127()
  migrate(db, join(root, 'schema'))
  db.prepare(`INSERT INTO precedent_sources (repo, number, title, merged_at, merger, files, issues)
    VALUES ('o/r', 7, 't', '2026-10-07T00:00:00Z', NULL, '[]', '[]')`).run()
  expect(() => db.prepare(`INSERT INTO precedent_threads (repo, number, kind, author, role, text, path, line)
    VALUES ('o/r', 7, 'review', 'x', 'contributor', 'why', NULL, NULL)`).run()).toThrow('NOT NULL constraint failed: precedent_threads.url')
})
