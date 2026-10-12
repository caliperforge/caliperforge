import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { commsLane, fileComms } from './comms.ts'
import { allPlans, laneOff, pipeNamed } from './plans.ts'

const schema = join(import.meta.dirname, '../schema')

it('files a comms title once and writes no second row', () => {
  const db = fresh(schema)
  commsLane(db)
  const plan = fileComms(db, 'daily 2026-10-10', null, '2026-10-10T20:30:00.000Z')
  expect(plan).not.toBeNull()
  expect(fileComms(db, 'daily 2026-10-10', null, '2026-10-10T21:00:00.000Z')).toBeNull()
  expect(allPlans(db).map((p) => p.id)).toEqual([plan])
})

it('a ticket sets lane, seat and origin; none leaves them null', () => {
  const db = fresh(schema)
  commsLane(db)
  fileComms(db, 'weekly 2026-10-12', null, '2026-10-11T09:00:00.000Z', { origin: 'https://github.com/caliperforge/caliperforge/issues/1', seat: 'typescript_specialist' })
  fileComms(db, 'daily 2026-10-11', null, '2026-10-11T20:30:00.000Z')
  expect(allPlans(db).map((p) => [p.lane, p.seat, p.origin]))
    .toEqual([['comms', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/1'], [null, null, null]])
})

it('makes a missing comms lane on and leaves an off one off', () => {
  const db = fresh(schema)
  commsLane(db)
  const lane = pipeNamed(db, 'comms')
  expect(lane?.enabled).toBe(1)
  laneOff(db, lane?.id ?? 0)
  commsLane(db)
  expect(pipeNamed(db, 'comms')?.enabled).toBe(0)
})
