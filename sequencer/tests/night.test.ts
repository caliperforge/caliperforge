import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { eventsOf } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { dial, enable, hours } from '../../store/lanes.ts'
import { take } from '../../store/leases.ts'
import { dropPipes, pipeNamed, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { dry, tick } from '../index.ts'
import { route } from '../next.ts'
import { mapOf } from '../steps.ts'
import { stub } from './world.ts'

/** 23:00 and 15:00 in Guatemala. */
const NIGHT = new Date('2026-09-19T05:00:00.000Z')
const DAY = new Date('2026-09-18T21:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function closed(steps: number[], template: PlanRow['template'] = 'bench'): Db {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  dial(db, 3, AT)
  const bench = Number(pipeNamed(db, 'bench')?.id)
  hours(db, bench, '07:00', '20:00')
  steps.forEach((step, i) => {
    putPlan(db, { id: i + 1, pipe_id: bench, target_id: null, template, state: 'queued', queued_at: AT, step, retries: 0,
      ...(template === 'pr_path' ? { lane: 'machine' as const, seat: 'typescript_specialist', origin: `https://github.com/caliperforge/caliperforge/issues/${String(i + 1)}` } : {}) })
  })
  return db
}

const would = (db: Db, now: Date) => dry(db, now).would.map((w) => w.plan)

test('a closed bench lane offers fuzzing plans only at refuzz', () => {
  for (const step of [2, 3]) {
    const db = closed([1, step])
    expect(would(db, NIGHT)).toEqual([2])
    expect(would(db, DAY)).toEqual([1])
    expect(route(db, planById(db, 2), DAY)).toEqual({ wait: 'bench_night', on: null })
  }
})

test('a second scorer at 23:00 waits on bench_score_busy', () => {
  const db = closed([2, 2])
  const lease = take(db, 1, new Date())
  expect(route(db, planById(db, 2), NIGHT)).toEqual({ wait: 'bench_score_busy', on: null })
  expect(route(db, planById(db, 1), NIGHT, lease)).toEqual({ fire: mapOf('bench').at(2) })
})

test('a tick at 23:00 fires score and leaves no bench_night wait', async () => {
  const db = closed([2])
  await tick(db, mkdtempSync(join(tmpdir(), 'cf-night-')), stub(''), NIGHT)
  expect(eventsOf(db, 1, 'bench.fired')).toHaveLength(1)
  expect(planById(db, 1).wait_reason).not.toBe('bench_night')
})

test('without open refuzz a closed bench lane offers nothing', () => {
  const db = closed([2])
  enable(db, Number(pipeNamed(db, 'refuzz')?.id), false)
  expect(would(db, NIGHT)).toEqual([])
  dropPipes(db, ['refuzz'])
  expect(would(db, NIGHT)).toEqual([])
})

test('a pr_path plan on a closed lane is never offered', () => {
  const db = closed([0], 'pr_path')
  expect(would(db, NIGHT)).toEqual([])
  expect(would(db, DAY)).toEqual([1])
})
