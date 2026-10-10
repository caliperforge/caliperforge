import { expect, test } from 'vitest'
import { width } from '../../store/lanes.ts'
import { held, take } from '../../store/leases.ts'
import { dropPlan } from '../../store/plans.ts'
import { lap, tick } from '../index.ts'
import { CARRIED, internalPlan, ours, plan, stub, watched, world } from './world.ts'

function two() {
  const w = world()
  dropPlan(w.db, 1)
  width(w.db, 1, 4)
  ours(w.root)
  internalPlan(w.db, w.root, 2, 'first job', 34)
  internalPlan(w.db, w.root, 3, 'second job', 35)
  return w
}

test('each=1 leases one job per lane per tick', async () => {
  const w = two()
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2), 0, undefined, 1)
  expect(new Set(fired.map((f) => f.plan)).size).toBe(1)
  expect([plan(w.db, 2).step, plan(w.db, 3).step].sort()).toEqual([0, 1])
})

test('each=1 takes the next job when another tick holds the first', async () => {
  const w = two()
  take(w.db, 2, new Date(), process.pid)
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 3), 0, undefined, 1)
  expect(fired.map((f) => f.plan)).toEqual([3])
  expect([plan(w.db, 2).step, plan(w.db, 3).step]).toEqual([0, 1])
})

test('default steps every job', async () => {
  const w = two()
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2))
  expect([plan(w.db, 2).step, plan(w.db, 3).step]).toEqual([1, 1])
})

test('apart runs each leased job away and frees what it never took', async () => {
  const w = two()
  const sent: number[] = []
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2), 0, undefined, 1,
    (id) => { sent.push(id); return Promise.resolve([]) })
  expect(sent).toHaveLength(1)
  expect(fired).toEqual([])
  expect(held(w.db)).toEqual([])
})

test('lap takes the lease from its tick and steps the job', async () => {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  const fired = await lap(w.db, w.root, stub(CARRIED), 2, 7, null)
  expect(fired.map((f) => f.plan)).toEqual([2])
  expect(plan(w.db, 2).step).toBe(1)
  expect(held(w.db)).toEqual([])
})

test('lap steps nothing its tick no longer holds', async () => {
  const w = two()
  take(w.db, 2, new Date(), 8)
  expect(await lap(w.db, w.root, stub(CARRIED), 2, 7, null)).toEqual([])
  expect(plan(w.db, 2).step).toBe(0)
})

test('lap takes no second step once the install moved', async () => {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  const fired = await lap(w.db, w.root, stub(CARRIED), 2, 7, null, 5, undefined, () => true)
  expect(fired).toHaveLength(1)
  expect(plan(w.db, 2).step).toBe(1)
  expect(held(w.db)).toEqual([])
})

test('lap keeps stepping while the install holds', async () => {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  expect((await lap(w.db, w.root, stub(CARRIED), 2, 7, null, 5)).length).toBeGreaterThan(1)
})

test('a job that only waited leaves the lane its job for this tick', async () => {
  const w = two()
  const sent: number[] = []
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2), 0, undefined, 1,
    (id) => {
      sent.push(id)
      const f = { pipe: 'internal', plan: id, step: 3, name: 'rails', outcome: 'pass' as const, state: 'running', spans: [], note: '', stole: null }
      return Promise.resolve(sent.length === 1 ? [{ ...f, held: true as const }] : [f])
    })
  expect(sent).toHaveLength(2)
  expect(fired.map((f) => f.held === true)).toEqual([true, false])
})
