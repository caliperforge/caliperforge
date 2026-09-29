import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open, type Db } from './index.ts'
import { planById } from './plans.ts'

const root = join(import.meta.dirname, '..')

const PLAN = 1

function bench(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/61')`).run(PLAN)
  return db
}

test('a plan comes back from planById equal to its row', () => {
  const db = bench()
  const plan = planById(db, PLAN)
  expect(plan.id).toBe(PLAN)
  expect(db.prepare('SELECT * FROM plans WHERE id = ?').get(PLAN)).toMatchObject(plan)
})

test('a renamed plans column fails the parse in planById', () => {
  const db = bench()
  db.exec('ALTER TABLE plans RENAME COLUMN wait_reason TO waiting')
  expect(() => planById(db, PLAN)).toThrow(/wait_reason/)
})

test('an id with no plans row throws no plan', () => {
  expect(() => planById(bench(), 99)).toThrow('no plan 99')
})
