import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { addPart } from '../../store/parts.ts'
import { addPipe, addPlan, end, planById, planRows, type PlanRow } from '../../store/plans.ts'
import { afterOf, allTickets, recordListing } from '../../store/tickets.ts'
import { steps as comms } from '../../templates/comms.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { released } from '../fixer.ts'
import { mapOf, measure } from '../steps.ts'
import { maybe } from '../workspace.ts'

const home = 'caliperforge/caliperforge'
const url = (no: number) => `https://github.com/${home}/issues/${String(no)}`

function listed(after: string) {
  const db = open(':memory:')
  migrate(db, join(import.meta.dirname, '../../schema'))
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
  addPart(db, { parent: a, n: 0, url: url(3), title: 't3', body: 'x', plan: a1 })
  addPart(db, { parent: a, n: 1, url: url(4), title: 't4', body: 'x', plan: a2Plan, after: 0 })
  const row = () => planRows(db).find((r) => r.id === b)
  return { db, root, b, a2: a2Plan, plan, row }
}

function both(c: PlanRow['state']) {
  const { db, root, plan } = listed('#1, #6')
  const [, b, cPlan] = [plan(1, 'done'), plan(2, 'running'), plan(6, c)]
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

test('a step no map has throws, and research has none', () => {
  expect(() => mapOf('comms').at(10)).toThrow('comms has no step 10')
  expect(() => mapOf('research').at(0)).toThrow('research has no step 0')
  expect(mapOf('research').steps).toEqual([])
})

test('a pr_path plan steps as templates/pr-path.ts does', () => {
  for (const { step } of steps) {
    for (const lang of [null, 'kotlin']) expect(mapOf('pr_path').at(step, lang)).toEqual(at(step, lang))
  }
  expect(mapOf('pr_path').last(8)).toBe(true)
})
