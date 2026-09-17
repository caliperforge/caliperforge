import { expect, test } from 'vitest'
import { laneLine } from '../../cli/brief.ts'
import { cap, dial, lanes, name, priority, record, set, templatePriority, windows, type Reading } from '../../store/lanes.ts'
import { picks, tick } from '../index.ts'
import { approve, CARRIED, stub, world, type World } from './world.ts'

const TODAY = new Date().toISOString().slice(0, 10)
const AT = `${TODAY}T09:00:00.000Z`

/** `usage` is unique on (kind, observed_at), so every reading a test takes needs its own stamp. */
const BASE = Date.now()
let seq = 0

const reading = (utilization: number, kind: Reading['rate_limit_type'] = 'seven_day', ago = 0): Reading => ({
  observed_at: new Date(BASE + (seq += 1) - ago * 1000).toISOString(),
  rate_limit_type: kind,
  resets_at: 1790222400,
  status: 'allowed_warning',
  utilization,
})

function queued(w: World, id: number, pipe: number, at: number): void {
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 1, 'pr_path', 'queued', ?, 0, 0, ?)`)
    .run(id, pipe, `${TODAY}T00:00:0${String(id)}.000Z`, at)
}

function second(w: World): void {
  w.db.prepare(`INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent)
    VALUES (2, 'research', 1, '00:00', '23:59', 1)`).run()
}

test('a plan is queued at its template default priority, and cf priority moves it', () => {
  const w = world()
  expect([templatePriority(w.db, 'pr_path'), templatePriority(w.db, 'research'), templatePriority(w.db, 'comms')])
    .toEqual([1, 2, 3])
  priority(w.db, 1, 0)
  expect(w.db.prepare('SELECT priority FROM plans WHERE id = 1').get()).toEqual({ priority: 0 })
  expect(() => { priority(w.db, 99, 0) }).toThrow(/no plan 99/)
  expect(() => w.db.prepare('UPDATE plans SET priority = 10 WHERE id = 1').run()).toThrow(/CHECK/)
})

test('within a lane the tick starts plans in priority order, in parallel up to max_concurrent', () => {
  const w = world()
  queued(w, 2, 1, 0)
  queued(w, 3, 1, 2)
  w.db.prepare('UPDATE pipes SET max_concurrent = 3 WHERE id = 1').run()
  expect(picks(w.db, { ...w.pipe, max_concurrent: 3 }, TODAY).map((p) => p.id)).toEqual([2, 1, 3])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 }, TODAY).map((p) => p.id)).toEqual([2, 1])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }, TODAY).map((p) => p.id)).toEqual([2])
  priority(w.db, 3, 0)
  expect(picks(w.db, { ...w.pipe, max_concurrent: 3 }, TODAY).map((p) => p.id)).toEqual([2, 3, 1])
})

test('a plan already running keeps its slot and a blocked queued plan takes none', async () => {
  const w = world()
  queued(w, 2, 1, 2)
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([1, 2])
  expect(w.db.prepare("SELECT count(*) AS n FROM plans WHERE state = 'running'").get()).toEqual({ n: 2 })
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 }, TODAY)).toEqual([])
  approve(w.db, w.target)
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 }, TODAY).map((p) => p.id)).toEqual([1, 2])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }, TODAY).map((p) => p.id)).toEqual([1, 2])
})

test('the cap decides how many pipes worth of plans the tick opens', async () => {
  const w = world()
  second(w)
  queued(w, 2, 2, 1)
  dial(w.db, 2, AT)
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.pipe)).toEqual(['pr-path', 'research'])
  w.db.prepare("UPDATE plans SET step = 0, state = 'queued'").run()
  dial(w.db, 1, AT)
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.pipe)).toEqual(['pr-path'])
  w.db.prepare("UPDATE plans SET step = 0, state = 'queued'").run()
  dial(w.db, 0, AT)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
})

test('the usage band steps the cap down as the window fills, and back up when it drains', () => {
  const w = world()
  dial(w.db, 4, AT)
  const stepped: (number | null)[] = []
  for (const u of [0.1, 0.45, 0.7, 0.95, 0.1]) {
    record(w.db, reading(u))
    stepped.push(cap(w.db).cap)
  }
  expect(stepped).toEqual([3, 2, 1, 0, 3])
  expect(name(0)).toBe('spot')
  expect(name(null)).toBe('none')
})

test('the fuller of the two windows rules, and a stale reading is no reading', () => {
  const w = world()
  dial(w.db, 4, AT)
  record(w.db, reading(0.1, 'seven_day'))
  record(w.db, reading(0.95, 'five_hour'))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: 0, cap: 0 })
  w.db.prepare('DELETE FROM usage').run()
  record(w.db, reading(0.95, 'seven_day', 7 * 3600))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: null, cap: 4 })
})

test('the dial never exceeds the band and the machine never exceeds the dial', () => {
  const w = world()
  dial(w.db, 1, AT)
  record(w.db, reading(0.1))
  expect(cap(w.db)).toMatchObject({ dial: 1, band: 3, ceiling: 4, cap: 1 })
  dial(w.db, 4, AT)
  record(w.db, reading(0.7))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: 1, cap: 1 })
  expect(() => { dial(w.db, 5, AT) }).toThrow(/cf lanes takes 0 to 4/)
  expect(() => { dial(w.db, -1, AT) }).toThrow(/cf lanes takes 0 to 4/)
})

test('a usage band moves by pr and a new settings key is born in a migration', () => {
  const w = world()
  expect(() => { set(w.db, 'lanes.band.p30', '4', 'pr', AT) }).toThrow(/moves by pr, in a migration/)
  expect(() => { set(w.db, 'lanes.spot', '1', 'ceo', AT) }).toThrow(/born in a migration/)
  set(w.db, 'lanes.ceiling', '3', 'pr', AT)
  expect(cap(w.db).ceiling).toBe(3)
})

test('cf brief and the queue query show live against open', async () => {
  const w = world()
  second(w)
  queued(w, 2, 2, 1)
  expect(laneLine(lanes(w.db, '09:00'))).toBe('lanes 0/2 live/open\tcap 2\tdial 2\tband none\tceiling 4\n')
  await tick(w.db, w.root, stub(CARRIED))
  expect(lanes(w.db, '09:00')).toMatchObject({ live: 2, open: 2 })
  dial(w.db, 0, AT)
  expect(laneLine(lanes(w.db, '09:00'))).toBe('lanes 2/0 live/open\tcap spot\tdial 0\tband none\tceiling 4\n')
})

test('the machine window view puts our tokens beside the cap, one row per window', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  record(w.db, reading(0.45))
  const rows = windows(w.db)
  expect(rows.map((r) => r.kind)).toEqual(['five_hour', 'seven_day'])
  expect(rows.map((r) => r.tokens)).toEqual([60, 60])
  expect(rows.map((r) => r.runs)).toEqual([1, 1])
  expect(rows.map((r) => r.cap)).toEqual([2, 2])
  expect(rows.map((r) => r.utilisation)).toEqual([null, 0.45])
})
