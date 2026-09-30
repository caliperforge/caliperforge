import { expect, test } from 'vitest'
import { clear, refused } from '../../store/refusals.ts'
import { retry } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { approve, CARRIED, plan, stub, world } from './world.ts'

test('past the token ceiling a job stops, and a retry resets it', async () => {
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
