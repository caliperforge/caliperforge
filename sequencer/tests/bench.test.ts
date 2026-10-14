import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { dial, enable } from '../../store/lanes.ts'
import { allPlans, pipeNamed, planById, putPlan, type PlanRow } from '../../store/plans.ts'
import { dry } from '../index.ts'
import { route } from '../next.ts'
import { mapOf } from '../steps.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 07:00 in Guatemala, when every lane's window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function queued(db: Db, template: PlanRow['template']): void {
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: AT, step: 0, retries: 0 })
}

test('a bench plan is stored and parsed', () => {
  const db = fresh(schema)
  queued(db, 'bench')
  expect(allPlans(db)).toMatchObject([{ id: 1, template: 'bench', state: 'queued', step: 0 }])
})

test('the bench map lists checkout, generate, score', () => {
  expect(mapOf('bench').steps.map((s) => s.name)).toEqual(['checkout', 'generate', 'score'])
})

test('an enabled bench pipe routes its plan to step 0', () => {
  const db = fresh(schema)
  enable(db, Number(pipeNamed(db, 'bench')?.id), true)
  dial(db, 3, AT)
  queued(db, 'bench')
  expect(dry(db, OPENS).would).toContainEqual({ pipe: 'bench', plan: 1, step: 0, template: 'bench' })
  expect(route(db, planById(db, 1), OPENS)).toEqual({ fire: mapOf('bench').at(0) })
})

test('an unknown template and a step past score are refused', () => {
  const db = fresh(schema)
  expect(() => { queued(db, 'nonsense' as PlanRow['template']) }).toThrow(/CHECK constraint failed/)
  expect(() => mapOf('bench').at(3)).toThrow('bench has no step 3')
})
