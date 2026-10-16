import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { PlanRow } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const insert = `INSERT INTO plans (pipe_id, template, state, queued_at, priority, lane, seat, origin, title)
  VALUES (1, 'pr_path', 'queued', '2026-10-16', 1, ?, 'web_specialist', ?, 't')`

it('D1 D2 D3 0107 admits loupe and keeps every plans row', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0106-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0107')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(insert).run('atelier', 'https://github.com/caliperforge/atelier-web/issues/1')
  const before = db.prepare('SELECT * FROM plans').all()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0107_loupe_lane.sql'])
  expect(db.prepare('SELECT * FROM plans').all()).toEqual(before)
  expect(() => db.prepare('SELECT * FROM outcomes').all()).not.toThrow()
  expect(() => db.prepare('SELECT * FROM queue_order').all()).not.toThrow()
  expect(db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'plans' AND type IN ('index', 'trigger') ORDER BY name").all())
    .toEqual([
      { type: 'trigger', name: 'plans_held_on_entry' },
      { type: 'trigger', name: 'plans_held_on_exit' },
      { type: 'trigger', name: 'plans_leave_batch_on_approval' },
      { type: 'index', name: 'plans_one_comms' },
      { type: 'index', name: 'plans_one_per_issue' },
    ])

  const id = db.prepare(insert).run('loupe', 'https://github.com/caliperforge/atelier-web/issues/2').lastInsertRowid
  const row = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
  expect(row.lane).toBe('loupe')
  expect(() => db.prepare(insert).run('lupe', 'https://github.com/caliperforge/atelier-web/issues/3')).toThrow(/CHECK constraint/)
  expect(() => PlanRow.parse({ ...row, lane: 'lupe' })).toThrow()
})
