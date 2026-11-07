import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { Opening } from '../precedents/openings.ts'
import { migrate, open } from './index.ts'
import { drifted, hashes, type Mismatch, mismatched } from './parity.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const below = (top: string) => {
  const old = mkdtempSync(join(tmpdir(), `cf-${top}-`))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < top)) {
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
  const db = below('0134')
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
  const db = below('0134')
  const insert = db.prepare(`INSERT INTO openings (id, repo, kind, area, quote, said_by, source, first_seen, status)
    VALUES (?, 'o/r', ?, 'a.ts', 'q', 'm', 's', '2026-10-01', ?)`)
  insert.run(5, 'deferred', 'taken')
  insert.run(9, 'repeated', 'open')
  const before = rows(db)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0134_parity.sql', '0135_runs_mode_handback.sql', '0136_openings_mismatch.sql', '0137_bench_phase_missed.sql', '0138_bench_cost_wall.sql'])
  expect(rows(db)).toEqual(before)
  insert.run(10, 'drift', 'open')
  expect(() => insert.run(11, 'other', 'open')).toThrow('CHECK constraint failed')
})

it('0136 keeps 0135 openings and accepts mismatch', () => {
  const db = below('0136')
  const insert = db.prepare(`INSERT INTO openings (id, repo, kind, area, quote, said_by, source, first_seen, status)
    VALUES (?, 'o/r', ?, 'a.ts', 'q', 'm', 's', '2026-10-01', ?)`)
  insert.run(5, 'deferred', 'taken')
  insert.run(9, 'drift', 'done')
  const before = db.prepare('SELECT * FROM openings ORDER BY id').all()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0136_openings_mismatch.sql', '0137_bench_phase_missed.sql', '0138_bench_cost_wall.sql'])
  expect(db.prepare('SELECT * FROM openings ORDER BY id').all()).toEqual(before)
  insert.run(10, 'mismatch', 'open')
  expect(() => insert.run(11, 'other', 'open')).toThrow('CHECK constraint failed')
})

const mismatch = (method: string, mainnet: string): Mismatch =>
  ({ method, case: 'empty', mainnet, surfpool: 'null', curls: ['curl mainnet', 'curl surfpool'] })

const mismatches = (db: ReturnType<typeof open>) =>
  db.prepare('SELECT id, repo, kind, area, quote, said_by, source, first_seen, status FROM openings ORDER BY id').all()

it('mismatched upserts a four-line quote and keeps its row', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  mismatched(db, 'solana-foundation/surfpool', '2026-11-01', [mismatch('getSlot', '1')])
  const first = { id: 1, repo: 'solana-foundation/surfpool', kind: 'mismatch', area: 'getSlot empty', said_by: 'parity_compare',
    source: 'mainnet, surfpool', first_seen: '2026-11-01', status: 'open' }
  expect(mismatches(db)).toEqual([{ ...first, quote: 'mainnet: 1\nsurfpool: null\ncurl mainnet\ncurl surfpool' }])
  mismatched(db, 'solana-foundation/surfpool', '2026-11-02', [mismatch('getSlot', '2')])
  expect(mismatches(db)).toEqual([{ ...first, quote: 'mainnet: 2\nsurfpool: null\ncurl mainnet\ncurl surfpool' }])
})

it('an unreported mismatch goes done, drift and others stay', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  mismatched(db, 'o/r', '2026-11-01', [mismatch('a', '1'), mismatch('b', '1'), mismatch('c', '1')])
  mismatched(db, 'o/s', '2026-11-01', [mismatch('a', '1')])
  drifted(db, 'o/r', '2026-11-01', [row('a (naming)', 'q')], {})
  db.exec("UPDATE openings SET status = 'taken' WHERE area = 'b empty'")
  mismatched(db, 'o/r', '2026-11-02', [mismatch('c', '1')])
  drifted(db, 'o/r', '2026-11-02', [row('a (naming)', 'q')], {})
  const status = db.prepare('SELECT status FROM openings ORDER BY id').pluck().all()
  expect(status).toEqual(['done', 'done', 'open', 'open', 'open'])
})
