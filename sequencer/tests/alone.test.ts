import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { refusalRows } from '../../store/refusals.ts'
import type { Ran } from '../checks.ts'
import { tick } from '../index.ts'
import { lock, unlock } from '../lock.ts'
import { maybe, put } from '../workspace.ts'
import { GREEN } from './bases.ts'
import { built, CARRIED, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const SLOW = 30000

const CAP = vi.hoisted(() => ({ on: false }))

vi.mock('../checks.ts', async (importOriginal) => {
  const real = await importOriginal<{ npm: (...args: unknown[]) => Ran }>()
  return { ...real, npm: (...args: unknown[]): Ran => CAP.on ? { ok: false, code: '143', output: '', capped: true } : real.npm(...args) }
})

beforeEach(() => {
  vi.stubEnv('CF_CHECK_SLOTS', '2')
  vi.stubEnv('CF_CHECK_SLOTS_DIR', mkdtempSync(join(tmpdir(), 'cf-slots-')))
})

afterEach(() => {
  CAP.on = false
  vi.unstubAllEnvs()
})

function kernel(): World {
  const w = world()
  w.db.exec('DELETE FROM plans WHERE id = 1')
  ours(w.root, GREEN)
  return w
}

function nineOnPlaceOne(w: World): void {
  lock(w.root, 8)
  lock(w.root, 9)
  unlock(w.root, 8)
}

async function lap(w: World): Promise<Awaited<ReturnType<typeof tick>>[number] | undefined> {
  return (await tick(w.db, w.root, stub(CARRIED))).find((f) => f.plan === 2)
}

/** The plan's step-3 lap, with `step-3.capped` in its folder when `capped`. */
async function railed(w: World, capped = false): Promise<Awaited<ReturnType<typeof tick>>[number] | undefined> {
  internalPlan(w.db, w.root, 2)
  if (capped) put(w.root, 2, 'step-3.capped', '')
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, 2, 'export const two = 2')
  return lap(w)
}

function places(w: World): string[] {
  return readdirSync(join(w.root, '.cf')).filter((name) => name.startsWith('checks.lock')).sort()
}

test('D2 a capped lap marks the plan and blips', async () => {
  const w = kernel()
  CAP.on = true
  expect(await railed(w)).toMatchObject({ step: 3, outcome: 'refuse', spans: ['checks:cap'] })
  expect(maybe(w.root, 2, 'step-3.capped')).toBe('')
  expect(plan(w.db, 2).step).toBe(3)
  expect(refusalRows(w.db, 2)).toEqual([])
}, SLOW)

test('D3 D4 a capped plan waits for every place, then runs', async () => {
  const w = kernel()
  nineOnPlaceOne(w)
  expect(await railed(w, true)).toMatchObject({ step: 3, held: true, note: 'checks wait: plan 9 is running its tests' })
  expect(places(w)).toEqual(['checks.lock.1'])
  unlock(w.root, 9)
  expect(await lap(w)).toMatchObject({ step: 3, outcome: 'pass' })
  expect(maybe(w.root, 2, 'step-3.capped')).toBeNull()
  expect(plan(w.db, 2).step).toBe(4)
}, SLOW)

test('D6 an uncapped plan runs beside another', async () => {
  const w = kernel()
  nineOnPlaceOne(w)
  expect(await railed(w)).toMatchObject({ step: 3, outcome: 'pass' })
}, SLOW)
