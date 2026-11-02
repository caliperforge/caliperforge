import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const at0129 = () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0129-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0130')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  return db
}

const SOURCE = `INSERT INTO precedent_sources (repo, number, title, merged_at, merger, files, issues)
  VALUES ('o/r', ?, 't', ?, 'boss', '["a.ts"]', '[3]')`

it('D5 0130 keeps 0129 rows and accepts a NULL merged_at', () => {
  const db = at0129()
  db.prepare(SOURCE).run(7, '2026-10-07T00:00:00Z')
  db.prepare(`INSERT INTO precedent_threads (repo, number, kind, author, role, text, path, line, url)
    VALUES ('o/r', 7, 'inline', 'x', 'contributor', 'why', 'a.ts', 4, 'https://github.com/o/r/pull/7#discussion_r1')`).run()
  expect(() => db.prepare(SOURCE).run(8, null)).toThrow('NOT NULL constraint failed: precedent_sources.merged_at')
  const rows = () => [db.prepare('SELECT * FROM precedent_sources').all(), db.prepare('SELECT * FROM precedent_threads').all()]
  const before = rows()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0130_precedent_open.sql', '0131_openings.sql', '0132_escapes.sql', '0133_precedent_findings.sql'])
  expect(rows()).toEqual(before)
  db.prepare(SOURCE).run(8, null)
  expect(db.prepare('SELECT merged_at FROM precedent_sources WHERE number = 8').pluck().get()).toBeNull()
})
