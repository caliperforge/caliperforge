import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from 'vitest'
import { walk } from '../checks/tree.ts'
import { eventsOf } from './events.ts'
import { migrate, open, type Db } from './index.ts'
import { priority } from './lanes.ts'
import { addPlan, briefed, clearWaitsOn, end, finish, holdOn, live, overlapWaits, pipeNamed, planById, requeue, resume, waiting,
  type PipeRow } from './plans.ts'

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

test('D2 a hand priority logs the old and new value and why', () => {
  const db = bench()
  priority(db, PLAN, 0, { actor: 'coo', why: 'w' })
  expect(planById(db, PLAN).priority).toBe(0)
  expect(db.prepare('SELECT kind, actor, message FROM events').all()).toEqual([{ kind: 'priority', actor: 'coo', message: 'P1 → P0: w' }])
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

test('D3 D4 overlapWaits drops finished plans, keeps queued ones', () => {
  const db = bench()
  add(db, 2, 'queued', T1)
  add(db, 3, 'queued', T1)
  const file = db.prepare('INSERT INTO plan_files (plan, path, is_new, position) VALUES (?, ?, 0, 0)')
  for (const plan of [PLAN, 2, 3]) file.run(plan, 'x.ts')
  waiting(db, [{ plan: 2, why: 'file_overlap', on: PLAN }, { plan: 3, why: 'file_overlap', on: PLAN }])
  finish(db, planById(db, 2))
  expect(db.prepare('SELECT wait_reason, waits_on FROM plans WHERE id = 2').get()).toEqual({ wait_reason: null, waits_on: null })
  expect(overlapWaits(db)).toEqual([{ plan: 3, on: PLAN, path: 'x.ts' }])
})

test('a second started rule is refused', () => {
  expect(() => bench().prepare("INSERT INTO queue_rules (key, wording) VALUES ('started', 'again')").run()).toThrow(/UNIQUE/)
})

test('D5: end clears wait_reason and waits_on on every end', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const other = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/2', step: 0 })
  const wait = (): unknown => db.prepare("UPDATE plans SET wait_reason = 'file_overlap', waits_on = ? WHERE id = ?").run(other, plan)
  const row = (): unknown => db.prepare('SELECT state, wait_reason, waits_on FROM plans WHERE id = ?').get(plan)
  const halts = [{ actor: 'tick', outcome: 'refuse', message: 'issue 1 closed' }]
  wait()
  end(db, plan, 'halted', 'issue 1 closed')
  expect(row()).toEqual({ state: 'halted', wait_reason: null, waits_on: null })
  expect(eventsOf(db, plan, 'halted')).toEqual(halts)
  wait()
  end(db, plan, 'refused')
  expect(row()).toEqual({ state: 'refused', wait_reason: null, waits_on: null })
  wait()
  end(db, plan, 'done')
  expect(row()).toEqual({ state: 'done', wait_reason: null, waits_on: null })
  expect(eventsOf(db, plan, 'halted')).toEqual(halts)
  expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
})

test('D1 D5 requeue/clearWaitsOn/holdOn/briefed set their columns', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 4 })
  const other = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/2', step: 0 })
  const row = (cols: string): unknown => db.prepare(`SELECT ${cols} FROM plans WHERE id = ?`).get(plan)
  requeue(db, plan, 2)
  expect(row('step, state')).toEqual({ step: 2, state: 'queued' })
  db.prepare("UPDATE plans SET held_why = 'kept' WHERE id = ?").run(plan)
  holdOn(db, plan, 'parked\nmore', null)
  expect(row('state, waits_on, held_why')).toEqual({ state: 'blocked_on_ceo', waits_on: null, held_why: 'kept' })
  holdOn(db, plan, 'waits\nmore', other)
  expect(row('state, waits_on, held_why')).toEqual({ state: 'blocked_on_ceo', waits_on: other, held_why: 'waits' })
  clearWaitsOn(db, plan)
  expect(row('waits_on, held_why')).toEqual({ waits_on: null, held_why: 'waits' })
  briefed(db, plan, { title: 't', what: 'w', why: null, ends: 'e' })
  expect(row('title, what, why, ends')).toEqual({ title: 't', what: 'w', why: null, ends: 'e' })
})

test('D4 resume skips unblocked plans, enters blocked ones by pipe', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare('UPDATE pipes SET max_concurrent = 1 WHERE id = 1').run()
  const plan = (no: number, from: 'queued' | 'blocked_on_ceo'): number => addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path',
    state: from, queued_at: '2026-09-27T00:00:00.000Z', lane: 'machine', seat: 'typescript_specialist',
    origin: `https://github.com/caliperforge/caliperforge/issues/${String(no)}`, step: 2 })
  const state = (id: number): unknown => (db.prepare('SELECT state FROM plans WHERE id = ?').get(id) as { state: string }).state
  const queued = plan(1, 'queued')
  resume(db, queued)
  expect(state(queued)).toBe('queued')
  const blocked = plan(2, 'blocked_on_ceo')
  resume(db, blocked)
  expect(state(blocked)).toBe('running')
  const full = plan(3, 'blocked_on_ceo')
  resume(db, full)
  expect(state(full)).toBe('queued')
})

test('D3 no non-test .ts outside store/ and schema/ writes plans', () => {
  const writers = walk(root, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((path) => relative(root, path).split(sep))
    .filter((parts) => !['store', 'schema'].includes(parts[0] ?? '') && !parts.includes('tests'))
    .map((parts) => parts.join('/'))
    .filter((path) => readFileSync(join(root, path), 'utf8').includes('UPDATE plans'))
  expect(writers).toEqual([])
})
