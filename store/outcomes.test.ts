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

test('D1 a retry whose refusal comes back is missed by that refusal', () => {
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

test('D3 a return before a refused close is missed by the close, and the close itself is open', () => {
  const db = plan('halted')
  returnToLane(db, 1)
  closed(db, 1, 'refused', 'ceo', 'no')
  expect(scored(db)).toEqual([
    { event: 1, actor: 'orchestrator', outcome: 'missed', refusal: null, close: 2 },
    { event: 2, actor: 'ceo', outcome: 'open', refusal: null, close: null },
  ])
})

test('D4 a release on a plan closed done holds, with the close as its row', () => {
  const db = plan('blocked_on_ceo', 2)
  refuse(db, X, '2026-09-19 10:00:00')
  release(db, 1, 'coo')
  closed(db, 1, 'done', 'ceo', 'landed')
  expect(scored(db)).toEqual([
    { event: 1, actor: 'coo', outcome: 'held', refusal: null, close: 2 },
    { event: 2, actor: 'ceo', outcome: 'held', refusal: null, close: null },
  ])
})

test('D4 a release on a plan finished without a close holds with no close', () => {
  const db = plan('blocked_on_ceo', 2)
  release(db, 1, 'coo')
  db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  expect(scored(db)).toEqual([{ event: 1, actor: 'coo', outcome: 'held', refusal: null, close: null }])
})

test('D5 events by other actors add no row, and a blip neither answers nor misses', () => {
  const db = plan('running')
  for (const actor of ['split', 'ciChecks', 'cf plan add']) event(db, actor, 'filed', '2026-09-20 09:00:00')
  refuse(db, X, '2026-09-20 10:00:00')
  refuse(db, BLIP, '2026-09-20 10:30:00', 1)
  event(db, 'ceo', 'retry', '2026-09-20 11:00:00')
  refuse(db, BLIP, '2026-09-20 12:00:00', 1)
  expect(scored(db)).toEqual([{ event: 4, actor: 'ceo', outcome: 'open', refusal: null, close: null }])
})
