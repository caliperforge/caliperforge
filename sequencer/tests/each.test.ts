import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test, vi } from 'vitest'
import { eventsOf, runRows } from '../../store/events.ts'
import { lapping } from '../../store/index.ts'
import { width } from '../../store/lanes.ts'
import { alive, BEAT, clear, held, take, type Taken } from '../../store/leases.ts'
import { dropPlan } from '../../store/plans.ts'
import { load } from '../../runner/rules.ts'
import { runOf } from '../../store/runs.ts'
import { lap, tick } from '../index.ts'
import { planDir } from '../workspace.ts'
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

const TURN = (id: string, [input, write, hour, read, output]: number[]) => JSON.stringify({ type: 'assistant', message: { id, content: [],
  usage: { input_tokens: input, cache_creation_input_tokens: write, cache_creation: { ephemeral_1h_input_tokens: hour }, cache_read_input_tokens: read, output_tokens: output } } })

const OLD = [TURN('a', [100, 1000, 400, 5000, 50]), TURN('a', [100, 1000, 400, 5000, 50]), TURN('b', [10, 0, 0, 6000, 20]),
  '{"type":"assistant","message":{"id":"c","usage":{"input_tokens":999'].join('\n')

/** The first job at step 1 with a lap's pending transcript beside it, and the packet that lap noted when `noted`. */
async function midStep(noted: boolean) {
  const w = two()
  take(w.db, 2, new Date(), 7)
  watched([], w.root, 2)
  await lap(w.db, w.root, stub(CARRIED), 2, 7, null)
  load(w.db, w.root)
  const dir = planDir(w.root, 2)
  writeFileSync(join(dir, 'step-1.pending.transcript.jsonl'), OLD)
  const note = join(dir, 'step-1.pending.packet.json')
  rmSync(note, { force: true })
  if (noted) {
    writeFileSync(note, JSON.stringify({ seat: 'brief_writer', model: 'claude-opus-5', effort: 'high' }))
    const then = new Date(Date.now() - 60_000)
    utimesSync(note, then, then)
  }
  return { w, dir, note }
}

async function diedMidStep(noted: boolean) {
  const at = await midStep(noted)
  const dead = spawnSync('/usr/bin/true').pid
  take(at.w.db, 2, new Date(), dead)
  take(at.w.db, 2, new Date(), 7)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await lap(at.w.db, at.w.root, stub(CARRIED), 2, 7, dead)
  } finally {
    vi.restoreAllMocks()
  }
  return { ...at, gone: join(at.dir, `step-1.dead-${String(dead)}.transcript.jsonl`) }
}

test('D1 D2 D3 D6 a dead lap\'s transcript is kept and charged', async () => {
  const { w, note, gone } = await diedMidStep(true)
  expect(readFileSync(gone, 'utf8')).toBe(OLD)
  const rows = runRows(w.db).filter((r) => r.plan === 2 && r.step === 1)
  expect(rows.map((r) => r.transcript_path)).toEqual([gone, expect.stringMatching(/\/run-\d+\.transcript\.jsonl$/)])
  expect(runOf(w.db, rows[0]?.id ?? 0)).toMatchObject({ seat: 'brief_writer', model: 'claude-opus-5', effort: 'high', exit: 1,
    input_tokens: 1110, cache_read_tokens: 11000, output_tokens: 70, cache_write_tokens: 1000, cache_write_1h_tokens: 400 })
  expect(runOf(w.db, rows[0]?.id ?? 0).cost_computed_usd).toBeCloseTo(0.01555, 8)
  expect(runOf(w.db, rows[0]?.id ?? 0).seconds).toBeGreaterThanOrEqual(59)
  expect(JSON.parse(readFileSync(note, 'utf8'))).toEqual({ seat: 'brief_writer', model: 'claude-opus-5-5', effort: 'high' })
})

test('D4 a dead lap\'s transcript with no packet is kept uncharged', async () => {
  const { w, gone } = await diedMidStep(false)
  expect(readFileSync(gone, 'utf8')).toBe(OLD)
  expect(runRows(w.db).filter((r) => r.transcript_path === gone)).toEqual([])
})

test('D5 a steal from a live pid keeps the pending transcript', async () => {
  const { w, dir } = await midStep(true)
  writeFileSync(join(dir, 'step-3.pending.transcript.jsonl'), OLD)
  const other = spawn('sleep', ['30'])
  try {
    take(w.db, 2, new Date(), 7)
    await lap(w.db, w.root, stub(CARRIED), 2, 7, Number(other.pid))
  } finally {
    other.kill()
  }
  expect(readFileSync(join(dir, 'step-3.pending.transcript.jsonl'), 'utf8')).toBe(OLD)
  expect(readdirSync(dir).filter((f) => f.includes('.dead-'))).toEqual([])
  expect(runRows(w.db).filter((r) => r.transcript_path.includes('.dead-'))).toEqual([])
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
