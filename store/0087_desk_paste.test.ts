import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5 0087 keeps desk posts, admits dest paste, not blog', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0086-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0087')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note,
    sources, checks, work_date, written_date, "order", proof_at, url, published_at)
    VALUES (1, 'weekly', 'substack', 'approved', 't', 'd', 'b', 'et', 'ed', 'eb', 'n', '["s"]', '["c"]', '2026-10-01', '2026-10-02', 3,
    '2026-10-02 10:00:00', 'https://caliperforge.com/blog/06_t.html', '2026-10-03 10:00:00')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before)
  const insert = db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (?, 'paste', ?, 'proof', 't', 'd', 'b', '[]', '[]', '2026-10-01', '2026-10-04')`)
  insert.run(2, 'paste')
  expect(() => insert.run(3, 'blog')).toThrow(/CHECK constraint failed/)
})
