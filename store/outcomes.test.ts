import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { closed, release, returnToLane } from './holds.ts'
import type { Db } from './index.ts'

const schema = join(import.meta.dirname, '../schema')

const X = 'a'.repeat(64)
const Y = 'b'.repeat(64)
const BLIP = '0'.repeat(64)

function plan(state: string, step = 3): Db {
  const db = fresh(schema)
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step)
    VALUES (1, 1, 'research', ?, '2026-09-19T00:00:00.000Z', ?)`).run(state, step)
  return db
}

function refuse(db: Db, fingerprint: string, at: string, blip = 0): void {
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip, at) VALUES (1, 3, ?, NULL, ?, ?)').run(fingerprint, blip, at)
}

function event(db: Db, actor: string, kind: string, at: string): void {
  db.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, ?, ?, ?, 'pass', '')").run(at, kind, actor)
}

const scored = (db: Db): unknown[] =>
  db.prepare('SELECT event, actor, outcome, refusal, close FROM outcomes ORDER BY event').all()

test('D1 a retry whose refusal comes back is missed by it', () => {
  const db = plan('running')
  refuse(db, X, '2026-09-20 10:00:00')
  event(db, 'ceo', 'retry', '2026-09-20 11:00:00')
  refuse(db, X, '2026-09-20 12:00:00')
  expect(scored(db)).toEqual([{ event: 1, actor: 'ceo', outcome: 'missed', refusal: 2, close: null }])
})

test.each([['done', 'held'], ['running', 'open']])('D2 a later refusal with another fingerprint misses nothing: %s reads %s', (state, outcome) => {
  const db = plan(state)
  refuse(db, X, '2026-09-20 10:00:00')
  event(db, 'ceo', 'retry', '2026-09-20 11:00:00')
  refuse(db, Y, '2026-09-20 12:00:00')
  expect(scored(db)).toEqual([{ event: 1, actor: 'ceo', outcome, refusal: null, close: null }])
})

test('D3 a refused close misses the return before it and is open', () => {
  const db = plan('halted')
  returnToLane(db, 1)
  closed(db, 1, 'refused', 'ceo', 'no')
  expect(scored(db)).toEqual([
    { event: 1, actor: 'orchestrator', outcome: 'missed', refusal: null, close: 2 },
    { event: 2, actor: 'ceo', outcome: 'open', refusal: null, close: null },
  ])
})

test('D4 a release on a done-closed plan holds, citing the close', () => {
  const db = plan('blocked_on_ceo', 2)
  refuse(db, X, '2026-09-19 10:00:00')
  release(db, 1, 'coo')
  closed(db, 1, 'done', 'ceo', 'landed')
  expect(scored(db)).toEqual([
    { event: 1, actor: 'coo', outcome: 'held', refusal: null, close: 2 },
    { event: 2, actor: 'ceo', outcome: 'held', refusal: null, close: null },
  ])
})

test('D4 release on a plan ended without a close holds, no close', () => {
  const db = plan('blocked_on_ceo', 2)
  release(db, 1, 'coo')
  db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  expect(scored(db)).toEqual([{ event: 1, actor: 'coo', outcome: 'held', refusal: null, close: null }])
})

test('D5 other actors add no row, nor does a blip answer or miss', () => {
  const db = plan('running')
  for (const actor of ['split', 'ciChecks', 'cf plan add']) event(db, actor, 'filed', '2026-09-20 09:00:00')
  refuse(db, X, '2026-09-20 10:00:00')
  refuse(db, BLIP, '2026-09-20 10:30:00', 1)
  event(db, 'ceo', 'retry', '2026-09-20 11:00:00')
  refuse(db, BLIP, '2026-09-20 12:00:00', 1)
  expect(scored(db)).toEqual([{ event: 4, actor: 'ceo', outcome: 'open', refusal: null, close: null }])
})

const FILED = 'https://github.com/caliperforge/caliperforge/issues/534'

function filed(db: Db, reason: string | null, wrong: number): void {
  db.prepare(`INSERT INTO tickets (repo, number, title, lane, state_reason, diagnosis_wrong)
    VALUES ('caliperforge/caliperforge', 534, 't', 'machine', ?, ?)`).run(reason, wrong)
  db.prepare(`INSERT INTO events (plan, at, kind, actor, outcome, message, pointer)
    VALUES (1, '2026-09-20 11:00:00', 'ticket', 'fixer', 'pass', '', ?)`).run(FILED)
}

const ticketed = (db: Db): unknown[] => db.prepare('SELECT outcome, refusal, ticket FROM outcomes').all()

test('D4 NOT_PLANNED misses its intervention even on a done plan', () => {
  const db = plan('done')
  filed(db, 'NOT_PLANNED', 0)
  expect(ticketed(db)).toEqual([{ outcome: 'missed', refusal: null, ticket: FILED }])
})

test('D5 an open diagnosis:wrong ticket misses its intervention', () => {
  const db = plan('running')
  filed(db, null, 1)
  expect(ticketed(db)).toEqual([{ outcome: 'missed', refusal: null, ticket: FILED }])
})

test.each([['done', 'held'], ['running', 'open']])('D6 a ticket closed COMPLETED leaves a %s plan %s', (state, outcome) => {
  const db = plan(state)
  filed(db, 'COMPLETED', 0)
  expect(ticketed(db)).toEqual([{ outcome, refusal: null, ticket: null }])
})

test('D6 a pointer with no tickets row leaves the plan to decide', () => {
  const db = plan('done')
  filed(db, 'NOT_PLANNED', 0)
  db.exec('DELETE FROM tickets')
  expect(ticketed(db)).toEqual([{ outcome: 'held', refusal: null, ticket: null }])
})
