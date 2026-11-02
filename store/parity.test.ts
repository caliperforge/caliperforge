import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { Opening } from '../precedents/openings.ts'
import { migrate, open } from './index.ts'
import { drifted, hashes } from './parity.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const at0133 = () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0133-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0134')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  return db
}

const row = (area: string, quote: string): Opening =>
  ({ kind: 'drift', area, quote, said_by: 'shape_compare', source: 'rust/src/traits.rs, go/core/types.go' })

const rows = (db: ReturnType<typeof open>) => db.prepare('SELECT id, area, quote, first_seen, status FROM openings ORDER BY id').all()

it('D4 an unreported drift goes done and a repeat keeps its row', () => {
  const db = at0133()
  migrate(db, join(root, 'schema'))
  drifted(db, 'o/r', '2026-11-01', [row('a (naming)', 'old'), row('b (types)', 'b')], { 'x.rs': '1', 'y.go': '2' })
  drifted(db, 'o/s', '2026-11-01', [row('a (naming)', 's')], {})
  drifted(db, 'o/r', '2026-11-02', [row('a (naming)', 'new')], { 'x.rs': '3', 'y.go': '2' })
  expect(rows(db)).toEqual([
    { id: 1, area: 'a (naming)', quote: 'new', first_seen: '2026-11-01', status: 'open' },
    { id: 2, area: 'b (types)', quote: 'b', first_seen: '2026-11-01', status: 'done' },
    { id: 3, area: 'a (naming)', quote: 's', first_seen: '2026-11-01', status: 'open' },
  ])
  expect(hashes(db, 'o/r')).toEqual({ 'x.rs': '3', 'y.go': '2' })
})

it('D7 0134 keeps 0133 openings and checks the kind', () => {
  const db = at0133()
  const insert = db.prepare(`INSERT INTO openings (id, repo, kind, area, quote, said_by, source, first_seen, status)
    VALUES (?, 'o/r', ?, 'a.ts', 'q', 'm', 's', '2026-10-01', ?)`)
  insert.run(5, 'deferred', 'taken')
  insert.run(9, 'repeated', 'open')
  const before = rows(db)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0134_parity.sql'])
  expect(rows(db)).toEqual(before)
  insert.run(10, 'drift', 'open')
  expect(() => insert.run(11, 'other', 'open')).toThrow('CHECK constraint failed')
})
