import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addRule, migrate, open } from '../../store/index.ts'
import { dial, hours } from '../../store/lanes.ts'
import { addPart } from '../../store/parts.ts'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf, logged, runRows } from '../../store/events.ts'
import { addPipe, addPlan, briefed, dropPipes, dropPlan, end, pipeNamed, planById, planRows, putPlan, requeue, type PlanRow } from '../../store/plans.ts'
import { afterOf, allTickets, recordListing } from '../../store/tickets.ts'
import { steps as comms, draft } from '../../templates/comms.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { drift } from '../drift.ts'
import { released } from '../fixer.ts'
import { tick } from '../index.ts'
import { route } from '../next.ts'
import { blocked, mapOf, measure } from '../steps.ts'
import { maybe, put } from '../workspace.ts'
import { REGISTRY } from './drifting.ts'
import { plan as planOf, stub, world, type World } from './world.ts'

const home = 'caliperforge/caliperforge'
const url = (no: number) => `https://github.com/${home}/issues/${String(no)}`
const pushed = (db: ReturnType<typeof open>, plan: number) => {
  pushedRow(db, { plan, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: `https://github.com/${home}/pull/1` }, gates(db, plan, 'd'.repeat(64)))
}

function listed(after: string) {
  const db = open(':memory:')
  migrate(db, join(import.meta.dirname, '../../schema'))
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-10-04' })
  addPipe(db, { name: 'after', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 })
  recordListing(db, home, [1, 2, 3, 4, 5, 6].map((number) => ({ number, title: `t${String(number)}`,
    body: number === 2 ? `b\n\nAfter: ${after}\n` : 'x', url: url(number), labels: [{ name: 'lane:machine' }], createdAt: '2026-10-03',
    closedAt: null, stateReason: null })), false)
  const plan = (no: number, state: PlanRow['state']) => addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state,
    queued_at: '2026-10-04', lane: 'machine', seat: 'typescript_specialist', origin: url(no), step: 0 })
  return { db, root: mkdtempSync(join(tmpdir(), 'cf-split-')), plan }
}

function split(a2: PlanRow['state']) {
  const { db, root, plan } = listed('#1')
  const [a, b, a1, a2Plan] = [plan(1, 'done'), plan(2, 'running'), plan(3, 'done'), plan(4, a2)]
  pushed(db, a1)
  addPart(db, { parent: a, n: 0, url: url(3), title: 't3', body: 'x', plan: a1 })
  addPart(db, { parent: a, n: 1, url: url(4), title: 't4', body: 'x', plan: a2Plan, after: 0 })
  const row = () => planRows(db).find((r) => r.id === b)
  return { db, root, b, a2: a2Plan, plan, row }
}

function both(c: PlanRow['state']) {
  const { db, root, plan } = listed('#1, #6')
  const [a, b, cPlan] = [plan(1, 'done'), plan(2, 'running'), plan(6, c)]
  pushed(db, a)
  const row = () => planRows(db).find((r) => r.id === b)
  return { db, root, b, c: cPlan, row }
}

test('D1 an After on a split waits on its open part', () => {
  const { db, root, b, a2, row } = split('running')
  expect(measure(db, root, planById(db, b))).toMatchObject({ outcome: 'pass', held: true, spans: ['#4'] })
  expect(row()).toMatchObject({ state: 'blocked_on_ceo', step: 0, waits_on: a2 })
  expect(row()?.held_why).toContain('#4 (part of #1)')
  expect(maybe(root, b, 'parked.md')).toContain('#4')
})

test('D2 once the last part lands, the After passes', () => {
  const { db, root, b, a2, row } = split('running')
  measure(db, root, planById(db, b))
  end(db, a2, 'done')
  pushed(db, a2)
  released(db, root, new Date('2026-10-04T09:00:00.000Z'), () => undefined)
  expect(row()).toMatchObject({ state: 'queued', step: 0, waits_on: null })
  const again = measure(db, root, planById(db, b))
  expect(again.outcome).toBe('pass')
  expect(again.held).toBeUndefined()
})

test('D3 a part that split too is followed to its own part', () => {
  const { db, root, b, a2, plan, row } = split('done')
  const a2a = plan(5, 'running')
  addPart(db, { parent: a2, n: 0, url: url(5), title: 't5', body: 'x', plan: a2a })
  measure(db, root, planById(db, b))
  expect(row()).toMatchObject({ state: 'blocked_on_ceo', waits_on: a2a })
})

test('D4 a halted part holds the After for the COO', () => {
  const { db, root, b, row } = split('halted')
  expect(measure(db, root, planById(db, b)).held).toBe(true)
  expect(row()).toMatchObject({ state: 'blocked_on_ceo', waits_on: null, held_by: 'coo', held_why: '#4 (part of #1) ended halted' })
})

test('D1 After: #1, #6 is recorded as [1,6]', () => {
  expect(afterOf('After: #745, #748')).toEqual([745, 748])
  expect(afterOf('x')).toEqual([])
  const { db } = listed('#1, #6')
  expect(allTickets(db).filter((t) => t.number <= 2).map((t) => t.after)).toEqual([null, '[1,6]'])
})

test('D2 an After on two issues waits on the open one', () => {
  const { db, root, b, c, row } = both('running')
  expect(measure(db, root, planById(db, b))).toMatchObject({ outcome: 'pass', held: true, spans: ['#6'] })
  expect(row()).toMatchObject({ state: 'blocked_on_ceo', waits_on: c })
  expect(row()?.held_why).toContain('#6')
})

test('D3 once both issues land, the After passes', () => {
  const { db, root, b, c, row } = both('running')
  measure(db, root, planById(db, b))
  end(db, c, 'done')
  pushed(db, c)
  released(db, root, new Date('2026-10-04T09:00:00.000Z'), () => undefined)
  expect(row()).toMatchObject({ state: 'queued', waits_on: null })
  const again = measure(db, root, planById(db, b))
  expect(again.outcome).toBe('pass')
  expect(again.held).toBeUndefined()
})

test('D4 a halted second issue holds the After for the COO', () => {
  const { db, root, b, c, row } = both('halted')
  expect(measure(db, root, planById(db, b)).held).toBe(true)
  expect(row()).toMatchObject({ state: 'blocked_on_ceo', waits_on: null, held_by: 'coo', held_why: `#6's plan ${String(c)} ended halted` })
})

test('a comms plan steps through templates/comms.ts', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(mapOf('comms').at(n)).toEqual(comms[n])
  expect(mapOf('comms').steps.map((s) => [s.step, s.name])).toEqual(
    ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score'].map((name, i) => [i, name]))
  expect(mapOf('comms').steps.filter((s) => s.fires !== 'kernel')).toMatchObject([
    { step: 1, name: 'draft', fires: 'seat', runs: 'writer' }, { step: 3, name: 'text_review', fires: 'seat', runs: 'text_review' },
    { step: 7, name: 'grow', fires: 'seat', runs: 'growth_lead' }])
})

test('D5: a step no map has throws; research has five', () => {
  expect(() => mapOf('comms').at(10)).toThrow('comms has no step 10')
  expect(() => mapOf('research').at(5)).toThrow('research has no step 5')
  expect(mapOf('research').steps.map((s) => s.name)).toEqual(['question', 'gather', 'check', 'review', 'record'])
})

const POST = 'Post: AI finds bugs faster than people fix them'
const NOTE = `not a post plan: "${POST}" starts with none of daily, ship, weekly, catchup`
const never: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('no seat fires') } }

const posting = (title: string): World => {
  const w = world()
  const { queued_at } = planOf(w.db, 1)
  dropPlan(w.db, 1)
  putPlan(w.db, { id: 1, pipe_id: 1, target_id: 1, template: 'comms', state: 'queued', queued_at, step: 0, retries: 0 })
  briefed(w.db, 1, { title, what: null, why: null, ends: null })
  requeue(w.db, 1, 1)
  put(w.root, 1, 'packet.json', JSON.stringify({ landed: [], refusals: [] }))
  return w
}

test('D1 a Post: title refuses at draft, naming the prefixes', async () => {
  const w = posting(POST)
  expect(await draft(w.db, w.root, planOf(w.db, 1), mapOf('comms').at(1), never)).toEqual({ outcome: 'refuse', spans: ['plans'], note: NOTE })
})

test('D2 D5 a Post: plan stops for the COO, not done', async () => {
  const w = posting(POST)
  expect(drift(w.db, REGISTRY.filter((e) => e.name === 'comms_not_a_post'), new Date())).toEqual([])
  const coo: Provider = { name: 'claude-agent-sdk', fire: (p) => p.prompt.includes('# writer') ? never.fire(p) : stub('').fire(p) }
  for (let n = 0; n < 2; n += 1) await tick(w.db, w.root, coo)
  expect(eventsOf(w.db, 1, 'draft').map((e) => e.outcome)).toEqual(['refuse', 'refuse'])
  expect(planRows(w.db).find((r) => r.id === 1)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo', held_why: NOTE })
  expect(runRows(w.db).map((r) => r.seat)).not.toContain('writer')
  expect(drift(w.db, REGISTRY.filter((e) => e.name === 'comms_not_a_post'), new Date())).toMatchObject([{ state: 'seen' }])
})

test('D3 a daily plan still fires the writer', async () => {
  const w = posting('daily 2026-10-23')
  const got = await draft(w.db, w.root, planOf(w.db, 1), mapOf('comms').at(1), stub('no fence'))
  expect(got.note).not.toMatch(/^not a post plan/)
  expect(runRows(w.db).map((r) => r.seat)).toEqual(['writer'])
})

test('a pr_path plan steps as templates/pr-path.ts does', () => {
  for (const { step } of steps) {
    for (const lang of [null, 'kotlin']) expect(mapOf('pr_path').at(step, lang)).toEqual(at(step, lang))
  }
  expect(mapOf('pr_path').last(8)).toBe(true)
})

/** 14:00, 23:00 and 21:30 in Guatemala. */
const DAY = new Date('2026-09-18T20:00:00.000Z')
const NIGHT = new Date('2026-09-19T05:00:00.000Z')
const DUSK = new Date('2026-09-19T03:30:00.000Z')

function benched(step: number, template: PlanRow['template'] = 'bench') {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  dial(db, 3, '2026-09-18T13:00:00.000Z')
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template, state: 'queued', queued_at: '2026-09-18T13:00:00.000Z', step, retries: 0,
    ...(template === 'pr_path' ? { lane: 'machine' as const, seat: 'typescript_specialist', origin: url(1) } : {}) })
  return db
}

const scratchRoot = () => mkdtempSync(join(tmpdir(), 'cf-night-'))

test('D1 a bench plan at score or null_check waits for night', () => {
  for (const step of [2, 3]) {
    const db = benched(step)
    expect(blocked(db, planById(db, 1), DAY)).toBe('bench_night')
  }
})

test('D2 at 23:00 score fires and logs one bench.fired', async () => {
  const db = benched(2)
  expect(route(db, planById(db, 1), NIGHT)).toEqual({ fire: mapOf('bench').at(2) })
  await tick(db, scratchRoot(), stub(''), NIGHT)
  expect(eventsOf(db, 1, 'bench.fired')).toMatchObject([{ actor: 'score', outcome: 'pass', message: 'score' }])
})

test('D3 checkout and generate fire at 14:00, logging none', async () => {
  for (const step of [0, 1]) {
    const db = benched(step)
    expect(route(db, planById(db, 1), DAY)).toEqual({ fire: mapOf('bench').at(step) })
  }
  const db = benched(1)
  await tick(db, scratchRoot(), stub(''), DAY)
  expect(eventsOf(db, 1, 'generate')).toHaveLength(1)
  expect(eventsOf(db, 1, 'bench.fired')).toEqual([])
})

test('D4 the refuzz row moves the gate; without it, it is open', () => {
  const db = benched(2)
  expect(blocked(db, planById(db, 1), DUSK)).toBe('bench_night')
  hours(db, Number(pipeNamed(db, 'refuzz')?.id), '21:00', '05:00')
  expect(route(db, planById(db, 1), DUSK)).toEqual({ fire: mapOf('bench').at(2) })
  dropPipes(db, ['refuzz'])
  expect(route(db, planById(db, 1), DAY)).toEqual({ fire: mapOf('bench').at(2) })
})

test('D5 a pr_path plan on the bench pipe is never bench_night', () => {
  const db = benched(0, 'pr_path')
  expect(blocked(db, planById(db, 1), DAY)).toBeNull()
})

test('D6 bench_night reports a bench.fired at 14:00, not 23:00', () => {
  const db = benched(2)
  const night = REGISTRY.filter((e) => e.name === 'bench_night')
  const local = (hour: number) => new Date(2026, 8, 18, hour).toISOString().replace('T', ' ').slice(0, 19)
  const fired = { plan: 1, kind: 'bench.fired', actor: 'score', outcome: 'pass' as const, message: 'score', pointer: null, run: null }
  const now = new Date(2026, 8, 19, 12)
  logged(db, fired, local(23))
  expect(drift(db, night, now)).toEqual([])
  logged(db, fired, local(14))
  expect(drift(db, night, now)).toMatchObject([{ name: 'bench_night', state: 'seen' }])
})
