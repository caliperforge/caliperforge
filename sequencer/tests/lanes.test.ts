import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { laneLine } from '../../cli/brief.ts'
import { release } from '../../store/holds.ts'
import type { Read } from '../../cli/gh.ts'
import { cap, dial, lanes, name, priority, record, set, templatePriority, windows, type Reading } from '../../store/lanes.ts'
import { live } from '../../store/plans.ts'
import { WHY } from '../../store/refusals.ts'
import { tick } from '../index.ts'
import { picks } from '../next.ts'
import { maybe, put, SELF } from '../workspace.ts'
import { approve, CARRIED, internalPlan, plan, stub, watched, world, type World } from './world.ts'

const ASK = '# hello\n\n- **D1** add `hello()` in `src/hello.ts`\n'

const TODAY = new Date().toISOString().slice(0, 10)
const AT = `${TODAY}T09:00:00.000Z`

const BASE = Date.now()
let seq = 0

const reading = (utilization: number, kind: Reading['rate_limit_type'] = 'seven_day', ago = 0,
  resets = 3 * 86400): Reading => ({
  observed_at: new Date(BASE + (seq += 1) - ago * 1000).toISOString(),
  rate_limit_type: kind,
  resets_at: Math.floor(BASE / 1000) + resets,
  status: 'allowed_warning',
  utilization,
})

function queued(w: World, id: number, pipe: number, at: number): void {
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries, priority)
    VALUES (?, ?, 1, 'pr_path', 'queued', ?, 0, 0, ?)`)
    .run(id, pipe, `${TODAY}T00:00:0${String(id)}.000Z`, at)
}

/** Issue 34, as `gh issue view` answers it, under whatever labels the test hangs on it. */
const labelled = (...names: string[]): Read => () => ({ number: 34, title: 'a plan of our own', body: 'ask',
  url: `https://github.com/${SELF}/issues/34`, labels: names.map((label) => ({ name: label })) })

function second(w: World): void {
  w.db.prepare(`INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent)
    VALUES (2, 'research', 1, '00:00', '23:59', 1)`).run()
}

test('a plan is queued at its template default priority, and cf priority moves it', async () => {
  const w = world()
  expect([templatePriority(w.db, 'pr_path'), templatePriority(w.db, 'research'), templatePriority(w.db, 'comms')])
    .toEqual([1, 2, 3])
  priority(w.db, 1, 0)
  expect(w.db.prepare('SELECT priority FROM plans WHERE id = 1').get()).toEqual({ priority: 0 })
  expect(() => { priority(w.db, 99, 0) }).toThrow(/no plan 99/)
  expect(() => { priority(w.db, 1, 2.5) }).toThrow(/cf priority takes P0 to P9/)
  expect(() => { priority(w.db, 1, 10) }).toThrow(/cf priority takes P0 to P9/)
  expect(() => w.db.prepare('UPDATE plans SET priority = 10 WHERE id = 1').run()).toThrow(/CHECK/)
  expect(() => w.db.prepare('UPDATE plans SET priority = 2.5 WHERE id = 1').run()).toThrow(/CHECK/)
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([1])
})

test('within a lane the tick starts plans in priority order, in parallel up to max_concurrent', () => {
  const w = world()
  queued(w, 2, 1, 0)
  queued(w, 3, 1, 2)
  w.db.prepare('UPDATE pipes SET max_concurrent = 3 WHERE id = 1').run()
  expect(picks(w.db, { ...w.pipe, max_concurrent: 3 }).map((p) => p.id)).toEqual([2, 1, 3])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 }).map((p) => p.id)).toEqual([2, 1])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }).map((p) => p.id)).toEqual([2])
  priority(w.db, 3, 0)
  expect(picks(w.db, { ...w.pipe, max_concurrent: 3 }).map((p) => p.id)).toEqual([2, 3, 1])
})

test('a plan already running keeps its slot and a blocked queued plan takes none', async () => {
  const w = world()
  queued(w, 2, 1, 2)
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([1, 2])
  expect(w.db.prepare("SELECT count(*) AS n FROM plans WHERE state = 'running'").get()).toEqual({ n: 2 })
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 })).toEqual([])
  approve(w.db, w.target)
  expect(picks(w.db, { ...w.pipe, max_concurrent: 2 }).map((p) => p.id)).toEqual([1, 2])
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }).map((p) => p.id)).toEqual([1, 2])
})

test('a plan already under way queues ahead of one not yet started', () => {
  const w = world()
  queued(w, 2, 1, 1)
  queued(w, 3, 1, 0)
  w.db.prepare("UPDATE plans SET step = 2, state = 'queued' WHERE id = 1").run()
  expect(live(w.db, w.pipe).map((p) => p.id)).toEqual([1, 3, 2])
})

test('a released plan waits for a free slot and the lane never runs past its width', async () => {
  const w = world()
  approve(w.db, w.target)
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  queued(w, 2, 1, 1)
  put(w.root, 2, 'ask.md', ASK)
  for (const id of [3, 4]) {
    queued(w, id, 1, 1)
    w.db.prepare("UPDATE plans SET step = 2, state = 'blocked_on_ceo' WHERE id = ?").run(id)
    put(w.root, id, 'issue.md', ASK)
  }
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([1, 2])

  release(w.db, 3)
  release(w.db, 4)
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([1, 2])
  expect(lanes(w.db, '09:00').live).toBe(2)

  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 1").run()
  expect((await tick(w.db, w.root, stub(CARRIED))).map((f) => f.plan)).toEqual([2, 3])
  expect(lanes(w.db, '09:00').live).toBe(2)
  expect(plan(w.db, 4)).toMatchObject({ step: 2, state: 'queued' })
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

test('a throw inside one plan\'s step is that plan\'s refusal, a repeat stops it, and the other lane still steps', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  second(w)
  queued(w, 2, 2, 1)
  dial(w.db, 2, AT)
  const stderr = 'Command failed: git push …\n! [rejected] … (fetch first)'
  const wire = { ...watched([], w.root, 1), send: () => { throw new Error(stderr) } }

  const first = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(first.find((f) => f.plan === 1)).toMatchObject({ step: 6, outcome: 'refuse', state: 'retried' })
  expect(first.find((f) => f.plan === 2)).toMatchObject({ pipe: 'research' })
  expect(plan(w.db, 1).step).toBe(6)
  expect(maybe(w.root, 1, 'refusal.md')).toContain(stderr)

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(maybe(w.root, 1, 'refusal.md')).toMatch(new RegExp(`# Stopped\\n\\n${WHY.repeat}\\.\\n$`))
})

test('the usage band steps the cap down as the window fills, and back up when it drains', () => {
  const w = world()
  dial(w.db, 4, AT)
  const stepped: (number | null)[] = []
  for (const u of [0.1, 0.45, 0.7, 0.9, 0.97, 0.1]) {
    record(w.db, reading(u))
    stepped.push(cap(w.db).cap)
  }
  expect(stepped).toEqual([3, 2, 1, 1, 0, 3])
  expect(name(0)).toBe('spot')
  expect(name(null)).toBe('none')
})

test('the fuller of the two windows rules, and an old reading holds until its window resets', () => {
  const w = world()
  dial(w.db, 4, AT)
  record(w.db, reading(0.1, 'seven_day'))
  record(w.db, reading(0.97, 'five_hour'))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: 0, cap: 0 })
  w.db.prepare('DELETE FROM usage').run()
  record(w.db, reading(0.95, 'seven_day', 13 * 3600))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: 1, cap: 1 })
  w.db.prepare('DELETE FROM usage').run()
  record(w.db, reading(0.95, 'seven_day', 13 * 3600, -60))
  expect(cap(w.db)).toMatchObject({ dial: 4, band: null, cap: 4 })
})

test('the latest reading is the one observed last, not the one recorded last', () => {
  const w = world()
  dial(w.db, 4, AT)
  record(w.db, reading(0.97, 'seven_day', 60))
  expect(cap(w.db)).toMatchObject({ band: 0, cap: 0 })
  record(w.db, reading(0.1, 'seven_day', 3600))
  expect(cap(w.db)).toMatchObject({ band: 0, cap: 0 })
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

test('a relabelled issue re-prices its plan within one tick, and steps it ahead of its lane-mates', async () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'a plan the ticket re-prices', 34, 2)
  expect(picks(w.db, w.pipe).map((p) => p.id)).toEqual([1])
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, undefined, 0, labelled('lane:machine', 'P0'))
  expect(plan(w.db, 2).priority).toBe(0)
  expect(fired.map((f) => f.plan)).toEqual([2])
})

test('an issue the tick cannot read, or one carrying two P labels, leaves the priority it has', async () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'a plan the ticket cannot re-price', 34, 2)
  const unread: Read = () => { throw new Error('gh: could not resolve to an issue') }
  for (const read of [unread, labelled('P0', 'P2')]) {
    const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, undefined, 0, read)
    expect(plan(w.db, 2).priority).toBe(2)
    expect(fired.map((f) => f.plan)).toEqual([1])
    w.db.prepare("UPDATE plans SET step = 0, state = 'queued'").run()
  }
})

test('the machine window view puts our tokens beside the cap, one row per window', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  record(w.db, reading(0.45))
  const rows = windows(w.db)
  expect(rows.map((r) => r.kind)).toEqual(['five_hour', 'seven_day'])
  expect(rows.map((r) => r.tokens)).toEqual([120, 120])
  expect(rows.map((r) => r.runs)).toEqual([2, 2])
  expect(rows.map((r) => r.cap)).toEqual([2, 2])
  expect(rows.map((r) => r.utilisation)).toEqual([null, 0.45])
})

/** #104: nothing wrote `usage` before; a run's own reading now steps the band. */
test('past 80% of the week one lane, past 95% none', async () => {
  const w = world()
  approve(w.db, w.target)
  dial(w.db, 4, AT)
  const inner = stub(CARRIED)
  const full = { ...inner, fire: async (p: Packet) => ({ ...(await inner.fire(p)), limits: [reading(0.83)] }) }
  const ran = (): unknown => w.db.prepare('SELECT 1 FROM runs').get()
  for (let at = 0; at < 4 && ran() === undefined; at += 1) await tick(w.db, w.root, full)
  expect(w.db.prepare('SELECT kind, utilisation FROM usage').all()).toEqual([{ kind: 'seven_day', utilisation: 0.83 }])
  expect(cap(w.db)).toMatchObject({ dial: 4, band: 1, cap: 1 })
  record(w.db, reading(0.97))
  expect(await tick(w.db, w.root, full)).toEqual([])
})
