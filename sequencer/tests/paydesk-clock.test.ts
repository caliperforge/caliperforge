import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Diffed } from '../../paydesk/live.ts'
import { ofKind, pointers } from '../../store/events.ts'
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

test('D1 two Monday calls on one date run the pass once', async () => {
  const db = world()
  const { dates, run } = stub()
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), run)
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), run)
  expect(dates).toEqual(['/root 2026-10-12'])
  expect(ofKind(db, 'paydesk_live')).toEqual([{ plan: null, kind: 'paydesk_live', actor: 'paydesk', outcome: 'pass',
    message: '1 newly failing, 0 newly passing, 2 gone' }])
  expect(pointers(db, 'paydesk_live')).toEqual(['2026-10-12'])
})

test('D2 before 05:00 Monday, Sunday and Tuesday never run', async () => {
  const db = world()
  const { dates, run } = stub()
  for (const at of ['2026-10-12T10:59:00Z', '2026-10-12T03:00:00Z', '2026-10-13T12:00:00Z']) {
    await paydesk(db, '/root', new Date(at), run)
  }
  expect(dates).toEqual([])
  expect(ofKind(db, 'paydesk_live')).toEqual([])
})

test('D3 a crash is logged once and not retried that date', async () => {
  const db = world()
  const { dates, run } = stub(new Error('clone failed'))
  await paydesk(db, '/root', new Date('2026-10-12T11:01:00Z'), run)
  await paydesk(db, '/root', new Date('2026-10-12T11:30:00Z'), run)
  expect(dates).toEqual(['/root 2026-10-12'])
  expect(ofKind(db, 'paydesk_live').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'clone failed']])
})
