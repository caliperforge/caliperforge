import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D6 0100 keeps desk posts, adds release as NULL', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0099-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0100')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date, proof_at)
    VALUES (1, 'catchup', 'site', 'proof', 't', 'd', 'b', '[]', '[]', '2026-10-01', '2026-10-02', '2026-10-02 10:00:00')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0100_desk_release.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, release: null })))
})
