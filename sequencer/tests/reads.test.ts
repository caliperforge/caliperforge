import { expect, test } from 'vitest'
import type { PlanRow } from '../../store/plans.ts'
import { machineReads } from '../seat.ts'

const plan = (lane: string | null) => ({ id: 1, lane } as unknown as PlanRow)

test('#274 atelier brief writer reads schema and cli', () => {
  expect(machineReads('/m', plan('atelier'), 'brief_writer')).toEqual(['/m/schema', '/m/cli'])
})

test('#274 no reads for other lanes or seats', () => {
  expect(machineReads('/m', plan('machine'), 'brief_writer')).toEqual([])
  expect(machineReads('/m', plan('atelier'), 'swift_specialist')).toEqual([])
  expect(machineReads('/m', plan(null), 'brief_writer')).toEqual([])
})
