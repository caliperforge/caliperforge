import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { dryLines } from '../../cli/brief.ts'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { dial, hhmm, zone } from '../../store/lanes.ts'
import { openPipes } from '../../store/plans.ts'
import { last, receipt } from '../../store/ticks.ts'
import { dry, tick } from '../index.ts'
import { CARRIED, stub } from './world.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 13:00 UTC is 07:00 in Guatemala, which is the minute the pr-path window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

function queued(db: Db, id: number, pipe: string, template: 'comms' | 'research'): void {
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number }
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries)
    VALUES (?, ?, ?, 'queued', ?, 0, 0)`).run(id, row.id, template, AT)
}

test('the store ships the three lanes the ceo opened, on, one at a time, 07:00 to 22:00', () => {
  const db = fresh(schema)
  expect(db.prepare('SELECT name, enabled, window_start, window_end, max_concurrent FROM pipes ORDER BY id').all())
    .toEqual([
      { name: 'pr-path', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'comms', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'research', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
    ])
})

test('the zone rule is one row, Guatemala, and every window is read against it', () => {
  const db = fresh(schema)
  expect(zone(db)).toBe(-360)
  expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'tick.zone%'").get()).toEqual({ n: 1 })
  expect(hhmm(db, OPENS)).toBe('07:00')
  expect(hhmm(db, new Date('2026-09-19T03:59:00.000Z'))).toBe('21:59')
  expect(openPipes(db, hhmm(db, new Date('2026-09-18T12:59:00.000Z')))).toEqual([])
  expect(openPipes(db, hhmm(db, OPENS)).map((p) => p.name)).toEqual(['pr-path', 'comms', 'research'])
  expect(openPipes(db, hhmm(db, new Date('2026-09-19T04:01:00.000Z')))).toEqual([])
})

test('a lane with no template reads as on with nothing queued, not as an error', async () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  const root = mkdtempSync(join(tmpdir(), 'cf-pipes-'))
  expect(await tick(db, root, stub(CARRIED), OPENS)).toEqual([])
  const would = dry(db, OPENS)
  expect(would).toMatchObject({ hhmm: '07:00', zone: -360, cap: 3, pipes: 3, would: [] })
  expect(would.quiet).toEqual([
    { pipe: 'pr-path', live: 0 }, { pipe: 'comms', live: 0 }, { pipe: 'research', live: 0 },
  ])
  expect(dryLines(would)).toBe('tick --dry\t07:00 utc-06:00\tcap 3\t3 pipe(s) open\n'
    + '  pr-path\ton, nothing queued\n  comms\ton, nothing queued\n  research\ton, nothing queued\n')
})

test('a plan queued on a lane with no step map is left where it stands, and stops no other lane', async () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 1, 'comms', 'comms')
  queued(db, 2, 'research', 'research')
  const root = mkdtempSync(join(tmpdir(), 'cf-pipes-'))
  expect(await tick(db, root, stub(CARRIED), OPENS)).toEqual([])
  expect(db.prepare("SELECT count(*) AS n FROM plans WHERE state <> 'queued'").get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 })
  const would = dry(db, OPENS)
  expect(would.would).toEqual([])
  expect(would.quiet).toEqual([
    { pipe: 'pr-path', live: 0 }, { pipe: 'comms', live: 1 }, { pipe: 'research', live: 1 },
  ])
  expect(dryLines(would)).toContain('  comms\ton, 1 queued and blocked\n')
})

test('the tick leaves its receipt in the store, dry runs included', () => {
  const db = fresh(schema)
  receipt(db, { at: AT, hhmm: '07:00', dry: true, pipes: 3, fired: 0, exit: 0, note: 'nothing to fire' })
  receipt(db, { at: AT, hhmm: '07:05', dry: false, pipes: 3, fired: 1, exit: 0, note: 'pr-path plan 1 step 4 review pass' })
  expect(last(db).map((r) => [r.hhmm, r.dry, r.fired])).toEqual([['07:05', false, 1], ['07:00', true, 0]])
  expect(() => receipt(db, { at: AT, hhmm: '7am', dry: false, pipes: 0, fired: 0, exit: 0, note: 'x' })).toThrow()
})
