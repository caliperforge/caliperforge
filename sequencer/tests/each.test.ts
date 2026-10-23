import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { eventsOf } from '../../store/events.ts'
import { lapping } from '../../store/index.ts'
import { width } from '../../store/lanes.ts'
import { alive, BEAT, clear, held, take, type Taken } from '../../store/leases.ts'
import { dropPlan } from '../../store/plans.ts'
import { lap, tick } from '../index.ts'
import { CARRIED, PASS, internalPlan, ours, plan, stub, watched, world } from './world.ts'

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

test('D4 lap runs its job under its plan', async () => {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  const seen: (number | undefined)[] = []
  await lap(w.db, w.root, stub(CARRIED, 0, PASS, () => seen.push(lapping.getStore())), 2, 7, null, 5)
  expect(new Set(seen)).toEqual(new Set([2]))
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

test('D1 the tick beats its lap\'s lease past the ceiling', async () => {
  const w = two()
  const taken: (Taken | null)[] = []
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 2), 0, undefined, 1, (id) => {
      clear(w.db, id)
      take(w.db, id, new Date(Date.now() - 4 * 3600_000))
      vi.advanceTimersByTime(BEAT)
      taken.push(take(w.db, id, new Date(), 7))
      return Promise.resolve([])
    })
  } finally {
    vi.useRealTimers()
  }
  expect(taken).toEqual([null])
})

/** A lease taken from `stole` and handed to this process, as `cf lap --stole` finds it. */
async function stolen(stole: number) {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  await lap(w.db, w.root, stub(CARRIED), 2, 7, stole)
  return w
}

test('D3 a steal kills the old lap and its child first', async () => {
  const sh = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait', 'cf.ts', 'lap', '2'])
  const child = Number(await new Promise<string>((done) => { sh.stdout.setEncoding('utf8').once('data', done) }))
  const killed = once(sh, 'exit')
  const w = await stolen(Number(sh.pid))
  expect((await killed)[1]).toBe('SIGKILL')
  for (let at = 0; at < 40 && alive(child); at += 1) await sleep(50)
  expect(alive(child)).toBe(false)
  expect(plan(w.db, 2).step).toBe(1)
  expect(eventsOf(w.db, 2, 'steal')).toEqual([{ actor: 'tick', outcome: 'pass',
    message: `took over pid ${String(sh.pid)}: alive, killed 2 processes` }])
})

test('D4 a steal leaves a live process that is not a lap', async () => {
  const other = spawn('sleep', ['30'])
  try {
    const w = await stolen(Number(other.pid))
    expect(alive(Number(other.pid))).toBe(true)
    expect(eventsOf(w.db, 2, 'steal').map((e) => e.message))
      .toEqual([`took over pid ${String(other.pid)}: alive, not a lap of plan 2`])
  } finally {
    other.kill()
  }
})

test('D5 a steal from a dead pid says so on stderr', async () => {
  const dead = spawnSync('/usr/bin/true').pid
  const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const w = await stolen(dead)
    expect(said).toHaveBeenCalledWith(`plan 2 took over pid ${String(dead)}: dead\n`)
    expect(eventsOf(w.db, 2, 'steal').map((e) => e.message)).toEqual([`took over pid ${String(dead)}: dead`])
  } finally {
    said.mockRestore()
  }
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
