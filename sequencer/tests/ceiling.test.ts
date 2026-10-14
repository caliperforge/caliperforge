import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { returnToLane, retried } from '../../store/holds.ts'
import { set } from '../../store/lanes.ts'
import { clear, refused } from '../../store/refusals.ts'
import { retry } from '../../store/plans.ts'
import { backdate, setInputTokens, spentLately } from '../../store/runs.ts'
import { unhold } from '../hold.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, plan, stub, world, type World } from './world.ts'

test('a job past its token ceiling stops; a retry counts afresh', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  // The director's wake on the stopped plan is not one of the job's own model runs.
  const provider = stub(CARRIED, 0, undefined, (p) => { if (!p.transcript.includes('director')) fired += 1 })
  while (fired === 0) await tick(w.db, w.root, provider)
  setInputTokens(w.db, 7000000)
  const before = fired
  await tick(w.db, w.root, provider)
  expect(fired).toBe(before)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')

  refused(w.db, { plan: 1, step: plan(w.db, 1).step, fingerprint: 'f'.repeat(64), diff: null })
  clear(w.db, 1)
  retry(w.db, plan(w.db, 1))
  await tick(w.db, w.root, provider)
  expect(fired).toBe(before + 1)
})

/** A plan stopped at a 1.5M ceiling, its runs two minutes old; `provider(1)` builds and exits 1. */
async function stopped(): Promise<{ w: World; provider: (exit?: number) => Provider; seen: { fired: number } }> {
  const w = world()
  approve(w.db, w.target)
  set(w.db, 'plan.token_ceiling', '1500000', 'pr', new Date().toISOString())
  const seen = { fired: 0 }
  const provider = (exit = 0): Provider =>
    stub(CARRIED, exit, undefined, (p) => { if (!p.transcript.includes('director')) seen.fired += 1 })
  while (seen.fired === 0) await tick(w.db, w.root, provider())
  setInputTokens(w.db, 1500000)
  await tick(w.db, w.root, provider())
  expect(seen.fired).toBe(1)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  backdate(w.db)
  return { w, provider, seen }
}

test('a return by coo starts the token count again', async () => {
  const { w, provider, seen } = await stopped()
  unhold(w.db, w.root, 1, 'coo')
  await tick(w.db, w.root, provider(1))
  expect(seen.fired).toBe(2)

  spentLately(w.db, 1500000)
  await tick(w.db, w.root, provider())
  expect(seen.fired).toBe(2)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(plan(w.db, 1).wait_reason).toBe('token_ceiling')
})

test('a retry by coo starts the token count again', async () => {
  const { w, provider, seen } = await stopped()
  retried(w.db, 1, 'coo')
  await tick(w.db, w.root, provider())
  expect(seen.fired).toBe(2)
})

test('a return by the orchestrator keeps the token count', async () => {
  const { w, provider, seen } = await stopped()
  returnToLane(w.db, 1)
  await tick(w.db, w.root, provider())
  expect(seen.fired).toBe(1)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(plan(w.db, 1).wait_reason).toBe('token_ceiling')
})
