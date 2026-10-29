import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { decided, decisions } from '../../store/decisions.ts'
import type { Db } from '../../store/index.ts'
import { dial } from '../../store/lanes.ts'
import { drop, take } from '../../store/leases.ts'
import { end, pipeNamed, planById, putPlan, waiting, type PlanRow, type Wait } from '../../store/plans.ts'
import { route } from '../next.ts'
import { blocked, mapOf } from '../steps.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 07:00 in Guatemala, when every lane's window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function queued(db: Db, id: number, step: number, template: PlanRow['template'] = 'bench'): void {
  putPlan(db, { id, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: AT, step, retries: 0 })
}

function two(step: number, pid: number = process.pid): Db {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 1, step)
  queued(db, 2, 2)
  take(db, 1, new Date(), pid)
  return db
}

test('D1 a second step-2 bench plan waits on the leased one', () => {
  const db = two(2)
  expect(blocked(db, planById(db, 2))).toBe('bench_score_busy')
  expect(route(db, planById(db, 2), OPENS)).toEqual({ wait: 'bench_score_busy', on: null })
})

test('D2 the leased plan is not held by its own lease', () => {
  const db = two(2)
  expect(blocked(db, planById(db, 1))).not.toBe('bench_score_busy')
})

test('D3 plan 2 fires once plan 1 is done, its lease row kept', () => {
  const db = two(2)
  end(db, 1, 'done')
  expect(route(db, planById(db, 2), OPENS)).toEqual({ fire: mapOf('bench').at(2) })
})

test('D3 plan 2 fires once plan 1 lease is dropped', () => {
  const db = two(2)
  drop(db, 1)
  expect(route(db, planById(db, 2), OPENS)).toEqual({ fire: mapOf('bench').at(2) })
})

test('D4 a leased bench plan at step 0 or 1 is not busy', () => {
  for (const step of [0, 1]) {
    const db = two(step)
    expect(route(db, planById(db, 2), OPENS)).toEqual({ fire: mapOf('bench').at(2) })
  }
})

test('D4 a step-2 lease whose pid is dead is not busy', () => {
  const db = two(2, spawnSync('/usr/bin/true').pid)
  expect(route(db, planById(db, 2), OPENS)).toEqual({ fire: mapOf('bench').at(2) })
})

test('D4 a non-bench plan is never bench_score_busy', () => {
  const db = two(2)
  queued(db, 3, 2, 'research')
  expect(blocked(db, planById(db, 3))).toBeNull()
})

test('D5 plans and decisions store bench_score_busy', () => {
  const db = two(2)
  waiting(db, [{ plan: 2, why: 'bench_score_busy' }])
  expect(planById(db, 2).wait_reason).toBe('bench_score_busy')
  const row = { plan: 2, step: 2, wait_reason: 'bench_score_busy' as const, verb: 'next' as const, why: 'scores one at a time', evidence: null, tokens: 0 }
  decided(db, row)
  expect(decisions(db, 2)).toEqual([row])
})

test('plans and decisions store bench_night', () => {
  const db = two(2)
  waiting(db, [{ plan: 2, why: 'bench_night' }])
  expect(planById(db, 2).wait_reason).toBe('bench_night')
  const row = { plan: 2, step: 2, wait_reason: 'bench_night' as const, verb: 'next' as const, why: 'fuzzes at night', evidence: null, tokens: 0 }
  decided(db, row)
  expect(decisions(db, 2)).toEqual([row])
})

test('D5 an unknown wait reason is refused by both tables', () => {
  const db = two(2)
  const why = 'bench_score_issue_busy' as Wait
  expect(() => { waiting(db, [{ plan: 2, why }]) }).toThrow(/CHECK constraint/)
  expect(() => decided(db, { plan: 2, step: 2, wait_reason: why, verb: 'next', why: 'x', evidence: null, tokens: 0 })).toThrow(/CHECK constraint/)
})
