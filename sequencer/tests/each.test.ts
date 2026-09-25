import { expect, test } from 'vitest'
import { tick } from '../index.ts'
import { CARRIED, internalPlan, ours, plan, stub, watched, world } from './world.ts'

function two() {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  w.db.prepare('UPDATE pipes SET max_concurrent = 4 WHERE id = 1').run()
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
  w.db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (2, ?, ?)').run(process.pid, new Date().toISOString())
  const fired = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 3), 0, undefined, 1)
  expect(fired.map((f) => f.plan)).toEqual([3])
  expect([plan(w.db, 2).step, plan(w.db, 3).step]).toEqual([0, 1])
})

test('default steps every job', async () => {
  const w = two()
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2))
  expect([plan(w.db, 2).step, plan(w.db, 3).step]).toEqual([1, 1])
})
