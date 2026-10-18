import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { dryLines } from '../../cli/brief.ts'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { runRows } from '../../store/events.ts'
import { dial, hhmm, pipes, settingKeys, zone } from '../../store/lanes.ts'
import { allPlans, openPipes, pipeNamed, putPlan } from '../../store/plans.ts'
import { last, receipt } from '../../store/ticks.ts'
import { dry, tick } from '../index.ts'
import { CARRIED, stub } from './world.ts'

const schema = join(import.meta.dirname, '../../schema')

/** 13:00 UTC is 07:00 in Guatemala, which is the minute the pr-path window opens. */
const OPENS = new Date('2026-09-18T13:00:00.000Z')

const AT = '2026-09-18T13:00:00.000Z'

/** A `pr_path` plan the store will take needs a target or an origin; ours is filed from one of our own issues. */
function queued(db: Db, id: number, pipe: string, template: 'comms' | 'research' | 'pr_path'): void {
  const origin = template === 'pr_path' ? `https://github.com/caliperforge/caliperforge/issues/${String(id)}` : null
  const ours = origin === null ? null : 'machine'
  putPlan(db, { id, pipe_id: Number(pipeNamed(db, pipe)?.id), target_id: null, template, state: 'queued', queued_at: AT, step: 0, retries: 0,
    origin, lane: ours, seat: ours === null ? null : 'typescript_specialist' })
}

test('the store ships three lanes, one each, 07:00 to 22:00',() => {
  const db = fresh(schema)
  expect(pipes(db))
    .toMatchObject([
      { name: 'pr-path', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'comms', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'research', enabled: 1, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'uniswap', enabled: 0, window_start: '07:00', window_end: '22:00', max_concurrent: 1 },
      { name: 'bench', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 },
      { name: 'site', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 },
      { name: 'rubin', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 },
      { name: 'bio', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 },
    ])
})

test('one zone row, Guatemala, and every window reads it',() => {
  const db = fresh(schema)
  expect(zone(db)).toBe(-360)
  expect(settingKeys(db, 'tick.zone*')).toHaveLength(1)
  expect(hhmm(db, OPENS)).toBe('07:00')
  expect(hhmm(db, new Date('2026-09-19T03:59:00.000Z'))).toBe('21:59')
  expect(openPipes(db, hhmm(db, new Date('2026-09-18T12:59:00.000Z'))).map((p) => p.name)).toEqual(['bench', 'site', 'rubin', 'bio'])
  expect(openPipes(db, hhmm(db, OPENS)).map((p) => p.name)).toEqual(['pr-path', 'comms', 'research', 'bench', 'site', 'rubin', 'bio'])
  expect(openPipes(db, hhmm(db, new Date('2026-09-19T04:01:00.000Z'))).map((p) => p.name)).toEqual(['bench', 'site', 'rubin', 'bio'])
})

test('a lane with no template reads as on, nothing queued',async () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  const root = mkdtempSync(join(tmpdir(), 'cf-pipes-'))
  expect(await tick(db, root, stub(CARRIED), OPENS)).toEqual([])
  const would = dry(db, OPENS)
  expect(would).toMatchObject({ hhmm: '07:00', zone: -360, cap: 3, pipes: 7, would: [] })
  expect(would.quiet).toEqual([
    { pipe: 'pr-path', live: 0, ready: 0 }, { pipe: 'comms', live: 0, ready: 0 },
    { pipe: 'research', live: 0, ready: 0 }, { pipe: 'bench', live: 0, ready: 0 },
    { pipe: 'site', live: 0, ready: 0 }, { pipe: 'rubin', live: 0, ready: 0 }, { pipe: 'bio', live: 0, ready: 0 },
  ])
  expect(dryLines(would)).toBe('tick --dry\t07:00 utc-06:00\tcap 3\t7 pipe(s) open\n'
    + '  pr-path\ton, nothing queued\n  comms\ton, nothing queued\n  research\ton, nothing queued\n  bench\ton, nothing queued\n'
    + '  site\ton, nothing queued\n  rubin\ton, nothing queued\n  bio\ton, nothing queued\n')
})

test('a queued research plan steps and stops no other lane',async () => {
  const db = fresh(schema)
  dial(db, 3, AT)
  queued(db, 2, 'research', 'research')
  const root = mkdtempSync(join(tmpdir(), 'cf-pipes-'))
  const would = dry(db, OPENS)
  expect(would.would).toEqual([{ pipe: 'research', plan: 2, step: 0, template: 'research' }])
  expect(would.quiet).toEqual([{ pipe: 'pr-path', live: 0, ready: 0 }, { pipe: 'comms', live: 0, ready: 0 },
    { pipe: 'bench', live: 0, ready: 0 }, { pipe: 'site', live: 0, ready: 0 }, { pipe: 'rubin', live: 0, ready: 0 },
    { pipe: 'bio', live: 0, ready: 0 }])
  expect(dryLines(would)).toContain('  research\tplan 2\tstep 0\tresearch\twould fire\n')
  expect(await tick(db, root, stub(CARRIED), OPENS)).toMatchObject([{ pipe: 'research', plan: 2, step: 0, name: 'question' }])
  expect(allPlans(db).filter((p) => p.state !== 'queued')).toHaveLength(1)
  expect(runRows(db)).toEqual([])
})

test('the cap goes to steppable lanes; a missed one says so',() => {
  const db = fresh(schema)
  dial(db, 1, AT)
  queued(db, 1, 'comms', 'pr_path')
  queued(db, 2, 'research', 'pr_path')
  const would = dry(db, OPENS)
  expect(would.cap).toBe(1)
  expect(would.pipes).toBe(7)
  expect(would.would).toEqual([{ pipe: 'comms', plan: 1, step: 0, template: 'pr_path' }])
  expect(would.quiet).toEqual([
    { pipe: 'pr-path', live: 0, ready: 0 }, { pipe: 'research', live: 1, ready: 1 },
    { pipe: 'bench', live: 0, ready: 0 }, { pipe: 'site', live: 0, ready: 0 },
    { pipe: 'rubin', live: 0, ready: 0 }, { pipe: 'bio', live: 0, ready: 0 },
  ])
  expect(dryLines(would)).toContain('  research\ton, 1 ready, cap spent on a lower lane\n')
})

test('the tick leaves its receipt in the store, dry runs included', () => {
  const db = fresh(schema)
  receipt(db, { at: AT, hhmm: '07:00', dry: true, pipes: 3, fired: 0, exit: 0, note: 'nothing to fire' })
  receipt(db, { at: AT, hhmm: '07:05', dry: false, pipes: 3, fired: 1, exit: 0, note: 'pr-path plan 1 step 4 review pass' })
  expect(last(db).map((r) => [r.hhmm, r.dry, r.fired])).toEqual([['07:05', false, 1], ['07:00', true, 0]])
  expect(() => receipt(db, { at: AT, hhmm: '7am', dry: false, pipes: 0, fired: 0, exit: 0, note: 'x' })).toThrow()
})
