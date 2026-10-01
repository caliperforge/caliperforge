import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { returnToLane, retried } from '../../store/holds.ts'
import { clear, refused } from '../../store/refusals.ts'
import { retry } from '../../store/plans.ts'
import { unhold } from '../hold.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, plan, stub, world, type World } from './world.ts'

test('a job past its token ceiling stops; a retry counts afresh', async () => {
  const w = world()
  approve(w.db, w.target)
  let fired = 0
  // The orchestrator's wake on the stopped plan is not one of the job's own model runs.
  const provider = stub(CARRIED, 0, undefined, (p) => { if (!p.transcript.includes('orchestrator')) fired += 1 })
  while (fired === 0) await tick(w.db, w.root, provider)
  w.db.prepare('UPDATE runs SET input_tokens = 7000000').run()
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
  w.db.prepare("UPDATE settings SET value = '1500000' WHERE key = 'plan.token_ceiling'").run()
  const seen = { fired: 0 }
  const provider = (exit = 0): Provider =>
    stub(CARRIED, exit, undefined, (p) => { if (!p.transcript.includes('orchestrator')) seen.fired += 1 })
  while (seen.fired === 0) await tick(w.db, w.root, provider())
  w.db.prepare('UPDATE runs SET input_tokens = 1500000').run()
  await tick(w.db, w.root, provider())
  expect(seen.fired).toBe(1)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  w.db.prepare("UPDATE runs SET at = datetime('now', '-2 minutes')").run()
  return { w, provider, seen }
}

test('a return by coo starts the token count again', async () => {
  const { w, provider, seen } = await stopped()
  unhold(w.db, w.root, 1, 'coo')
  await tick(w.db, w.root, provider(1))
  expect(seen.fired).toBe(2)

  w.db.prepare(`UPDATE runs SET input_tokens = 1500000, at = datetime('now', '+1 minute')
    WHERE julianday(at) > julianday('now', '-1 minute')`).run()
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
