import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open, type Db } from './index.ts'
import { live, pipeNamed, planById, waiting, type PipeRow } from './plans.ts'

const root = join(import.meta.dirname, '..')

const PLAN = 1

const T1 = '2026-09-20T00:00:00.000Z'
const T2 = '2026-09-21T00:00:00.000Z'
const T3 = '2026-09-22T00:00:00.000Z'

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

function add(db: Db, id: number, state: string, at: string): void {
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', ?, ?, 'machine', 'typescript_specialist', ?)`)
    .run(id, state, at, `https://github.com/caliperforge/caliperforge/issues/${String(60 + id)}`)
}

function queue(): { db: Db; pipe: PipeRow } {
  const db = bench()
  add(db, 2, 'queued', T1)
  add(db, 3, 'queued', T3)
  add(db, 4, 'queued', T2)
  add(db, 5, 'queued', T2)
  db.exec('UPDATE plans SET priority = 2 WHERE id = 2')
  db.exec('UPDATE plans SET step = 2 WHERE id = 3')
  const pipe = pipeNamed(db, 'pr-path')
  if (pipe === null) throw new Error('no pipe')
  return { db, pipe }
}

function order(db: Db): { plan: number; position: number; rule: number | null; key: string | null; waiting: string | null }[] {
  return db.prepare(`SELECT q.plan, q.position, q.rule, r.key, q.waiting FROM queue_order q
    LEFT JOIN queue_rules r ON r.id = q.rule WHERE q.pipe = 1 ORDER BY q.position`).all() as ReturnType<typeof order>
}

test('live and queue_order put the five plans in the same order', () => {
  const { db, pipe } = queue()
  expect(live(db, pipe).map((p) => p.id)).toEqual([3, 1, 4, 5, 2])
  expect(order(db).map((r) => [r.plan, r.position])).toEqual([[3, 1], [1, 2], [4, 3], [5, 4], [2, 5]])
})

test('each row names the rule that puts it ahead of the next', () => {
  expect(order(queue().db).map((r) => [r.rule, r.key])).toEqual(
    [[1, 'started'], [3, 'queued_at'], [4, 'id'], [2, 'priority'], [null, null]])
})

test('a plan waiting on files shows file_overlap', () => {
  const { db } = queue()
  waiting(db, [{ plan: 4, why: 'file_overlap', on: 3 }])
  expect(order(db).map((r) => [r.plan, r.waiting])).toEqual([[3, null], [1, null], [4, 'file_overlap'], [5, null], [2, null]])
})

test('a plan not queued or running takes no place in the queue', () => {
  const { db } = queue()
  for (const [id, state] of [[6, 'done'], [7, 'refused'], [8, 'halted'], [9, 'blocked_on_ceo']] as const) add(db, id, state, T1)
  db.exec('UPDATE plans SET step = 2, priority = 0 WHERE id > 5')
  expect(order(db).map((r) => [r.plan, r.position])).toEqual([[3, 1], [1, 2], [4, 3], [5, 4], [2, 5]])
})

test('a second started rule is refused', () => {
  expect(() => bench().prepare("INSERT INTO queue_rules (key, wording) VALUES ('started', 'again')").run()).toThrow(/UNIQUE/)
})
