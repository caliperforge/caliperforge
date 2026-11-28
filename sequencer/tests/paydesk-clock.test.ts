import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Diffed } from '../../paydesk/live.ts'
import type { Renewed } from '../../paydesk/renew.ts'
import { logged, ofKind, pointers } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { paydesk } from '../signals.ts'

const schema = join(import.meta.dirname, '../../schema')

function world(): Db {
  const db = fresh(schema)
  set(db, 'tick.zone_offset_minutes', '-360', 'ceo', '2026-10-01')
  return db
}

function stub(error?: Error): { dates: string[]; run: (root: string, date: string) => Promise<Diffed> } {
  const dates: string[] = []
  return { dates, run: (root, date) => {
    dates.push(`${root} ${date}`)
    return error === undefined ? Promise.resolve({ failing: ['a'], passing: [], gone: ['b', 'c'] }) : Promise.reject(error)
  } }
}

function renewal(error?: Error): { dates: string[]; renew: (root: string, date: string) => Promise<Renewed> } {
  const dates: string[] = []
  return { dates, renew: (root, date) => {
    dates.push(`${root} ${date}`)
    return error === undefined ? Promise.resolve({ attested: 1, renewed: 2, closed: 3, skipped: 4, failed: 0 }) : Promise.reject(error)
  } }
}

test('D1 two Monday calls on one date run the pass once', async () => {
  const db = world()
  const { dates, run } = stub()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), false, run)
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), false, run)
  expect(dates).toEqual(['/root 2026-10-12'])
  expect(ofKind(db, 'paydesk_live')).toEqual([
    { plan: null, kind: 'paydesk_live', actor: 'paydesk', outcome: 'start', message: 'started' },
    { plan: null, kind: 'paydesk_live', actor: 'paydesk', outcome: 'pass', message: '1 newly failing, 0 newly passing, 2 gone' }])
  expect(pointers(db, 'paydesk_live')).toEqual(['2026-10-12', '2026-10-12'])
})

test('a call during a running pass neither runs nor renews', async () => {
  const db = world()
  let finish = (): void => undefined
  let runs = 0
  const run = (): Promise<Diffed> => {
    runs += 1
    return new Promise((resolve) => { finish = () => { resolve({ failing: [], passing: [], gone: [] }) } })
  }
  const { dates, renew } = renewal()
  const first = paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), true, run, renew)
  await paydesk(db, '/root', new Date('2026-10-12T11:02:00Z'), true, run, renew)
  finish()
  await first
  expect([runs, dates]).toEqual([1, ['/root 2026-10-12']])
  expect(ofKind(db, 'paydesk_live').map((e) => e.outcome)).toEqual(['start', 'pass'])
})

test('a date with only a start row is not run again', async () => {
  const db = world()
  logged(db, { plan: null, kind: 'paydesk_live', actor: 'paydesk', outcome: 'start', message: 'started', pointer: '2026-10-12', run: null })
  const { dates, run } = stub()
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), false, run)
  expect(dates).toEqual([])
  expect(ofKind(db, 'paydesk_live').map((e) => e.outcome)).toEqual(['start'])
})

test('the next Monday runs again', async () => {
  const db = world()
  const { dates, run } = stub()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), false, run)
  await paydesk(db, '/root', new Date('2026-10-19T11:01:00Z'), false, run)
  expect(dates).toEqual(['/root 2026-10-12', '/root 2026-10-19'])
  expect(pointers(db, 'paydesk_live')).toEqual(['2026-10-12', '2026-10-12', '2026-10-19', '2026-10-19'])
})

test('D2 before 05:00 Monday, Sunday and Tuesday never run', async () => {
  const db = world()
  const { dates, run } = stub()
  for (const at of ['2026-10-12T10:59:00Z', '2026-10-12T03:00:00Z', '2026-10-13T12:00:00Z']) {
    await paydesk(db, '/root', new Date(at), false, run)
  }
  expect(dates).toEqual([])
  expect(ofKind(db, 'paydesk_live')).toEqual([])
})

test('D3 a crash is logged once and not retried that date', async () => {
  const db = world()
  const { dates, run } = stub(new Error('clone failed'))
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), false, run)
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), false, run)
  expect(dates).toEqual(['/root 2026-10-12'])
  expect(ofKind(db, 'paydesk_live').map((e) => [e.outcome, e.message])).toEqual([['start', 'started'], ['refuse', 'clone failed']])
})

test('a passing live pass renews once per date with its counts', async () => {
  const db = world()
  const { run } = stub()
  const { dates, renew } = renewal()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), true, run, renew)
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), true, run, renew)
  expect(dates).toEqual(['/root 2026-10-12'])
  expect(ofKind(db, 'paydesk_attest')).toEqual([{ plan: null, kind: 'paydesk_attest', actor: 'paydesk', outcome: 'pass',
    message: '1 attested, 2 renewed, 3 closed, 4 skipped, 0 failed' }])
  expect(pointers(db, 'paydesk_attest')).toEqual(['2026-10-12'])
})

test('attest off never renews', async () => {
  const db = world()
  const { dates, renew } = renewal()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), false, stub().run, renew)
  expect([dates, ofKind(db, 'paydesk_attest')]).toEqual([[], []])
})

test('a renewal that throws is refused with its message', async () => {
  const db = world()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), true, stub().run, renewal(new Error('no attest config at x')).renew)
  expect(ofKind(db, 'paydesk_attest').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'no attest config at x']])
  expect(ofKind(db, 'paydesk_live').map((e) => e.outcome)).toEqual(['start', 'pass'])
})

test('a refused live pass never renews', async () => {
  const db = world()
  const { dates, renew } = renewal()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), true, stub(new Error('clone failed')).run, renew)
  expect([dates, ofKind(db, 'paydesk_attest')]).toEqual([[], []])
})
