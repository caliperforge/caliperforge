import { expect, test } from 'vitest'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { logged, ofKind } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { enable } from '../../store/lanes.ts'
import { addPlan, dropPlan, pipeOf, planById, type PlanRow } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { tick } from '../index.ts'
import { relane } from '../relane.ts'
import { db, REGISTRY } from './drifting.ts'
import { stub, world } from './world.ts'

const FIX = 'https://github.com/caliperforge/caliperforge/issues/90'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const BACK_ON = REGISTRY.filter((e) => e.name === 'lane_back_on')

/** A pipe settle turned off, and the fix the director filed for its stop, in `state`. */
function stopped(d: Db, pipe: number, state: PlanRow['state'] = 'done', push = true): void {
  const plan = (s: PlanRow['state'], origin: string) => addPlan(d, { pipe_id: pipe, target_id: null, template: 'pr_path', state: s,
    queued_at: '2026-10-13', lane: 'machine', seat: 'typescript_specialist', origin, step: 0 })
  const stop = plan('refused', 'https://github.com/caliperforge/caliperforge/issues/89')
  enable(d, pipe, false)
  logged(d, { plan: stop, kind: 'pipe', actor: 'settle', outcome: 'escalate', message: 'lane off', pointer: null, run: null })
  logged(d, { plan: stop, kind: 'director', actor: 'director', outcome: 'pass', message: 'file: fix', pointer: FIX, run: null })
  const fix = plan(state, FIX)
  if (!push) return
  addRule(d, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-10-13' })
  pushedRow(d, { plan: fix, step: 8, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: `https://github.com/caliperforge/caliperforge/commit/${SHA}` }, gates(d, fix, 'd'.repeat(64)))
}

function store(): { d: Db; pipe: number; name: string } {
  const d = db()
  const { id, name } = pipeOf(d, planById(d, 1).pipe_id)
  return { d, pipe: id, name }
}

const ons = (d: Db) => ofKind(d, 'pipe').filter((e) => e.actor === 'tick')

test('D1 a tick turns the lane back on once its fix lands', async () => {
  const w = world()
  dropPlan(w.db, 1)
  stopped(w.db, w.pipe.id)
  await tick(w.db, w.root, stub(''))
  expect(pipeOf(w.db, w.pipe.id).enabled).toBe(1)
  expect(ons(w.db)).toMatchObject([{ outcome: 'pass', message: `${w.pipe.name} on: fix for ${FIX} landed as ${SHA.slice(0, 12)}` }])
})

test('D2 a ceo or coo pipe event after the stop keeps it off', () => {
  for (const actor of ['ceo', 'coo']) {
    const { d, pipe, name } = store()
    stopped(d, pipe)
    logged(d, { plan: null, kind: 'pipe', actor, outcome: 'pass', message: `${name} width 1`, pointer: null, run: null })
    relane(d)
    expect(pipeOf(d, pipe).enabled).toBe(0)
    expect(ons(d)).toEqual([])
  }
})

test('D3 a refused or unpushed fix keeps the lane off', () => {
  for (const state of ['refused', 'running'] as const) {
    const { d, pipe } = store()
    stopped(d, pipe, state, false)
    relane(d)
    expect(pipeOf(d, pipe).enabled).toBe(0)
    expect(ons(d)).toEqual([])
  }
})

test('D4 a second relane writes no second event', () => {
  const { d, pipe } = store()
  stopped(d, pipe)
  relane(d)
  enable(d, pipe, false)
  relane(d)
  expect(pipeOf(d, pipe).enabled).toBe(0)
  expect(ons(d)).toHaveLength(1)
})

test('D5 drift reads lane_back_on until relane runs', () => {
  const { d, pipe } = store()
  stopped(d, pipe)
  expect(drift(d, BACK_ON, new Date())).toEqual([{ name: 'lane_back_on', state: 'silent',
    detail: "no row in events WHERE kind = 'pipe' AND actor = 'tick'" }])
  relane(d)
  expect(drift(d, BACK_ON, new Date())).toEqual([])
})
