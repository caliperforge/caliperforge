import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { dump, migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('applies every migration once and records the version', () => {
  const db = open(':memory:')
  expect(migrate(db, join(root, 'schema'))).toEqual(['0001_init.sql', '0002_rulings.sql', '0003_runs_rule_hash.sql', '0004_one_disposition_per_verdict.sql', '0005_tick.sql', '0006_runs_transcript_path.sql', '0007_batch.sql'])
  expect(db.pragma('user_version', { simple: true })).toBe(7)
  expect(migrate(db, join(root, 'schema'))).toEqual([])
})

it('dumps a database that replays into an identical one', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare("INSERT INTO rules VALUES ('r', 'rail', 'rules/rails.yaml', ?, '2026-09-16')").run('a'.repeat(64))
  const out = join(mkdtempSync(join(tmpdir(), 'cf-')), 'dump.sql')
  dump(db, out)
  const replay = open(':memory:')
  replay.exec(readFileSync(out, 'utf8'))
  expect(replay.prepare('SELECT id FROM rules').all()).toEqual([{ id: 'r' }])
})
