import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { eventsOf } from '../../store/events.ts'
import { dropPlan, rewind } from '../../store/plans.ts'
import { runTokens } from '../../store/runs.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { approve, built, CARRIED, internalPlan, ours, PASS, plan, REFUSE, stub, watched, world, type World } from './world.ts'

const MINE = 2

const blindly = (blind: string): Provider => {
  const rest = stub(CARRIED)
  const own = stub(CARRIED, 0, blind)
  return { ...rest, fire: (p) => (p.prompt.includes('# blind_review') ? own : rest).fire(p) }
}

async function outside(provider: Provider, sent: string[] = []): Promise<World> {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, provider, undefined, undefined, watched(sent, w.root, 1))
  return w
}

const fifth = (w: World, id: number): unknown => runTokens(w.db, id)
  .filter((r) => r.seat === 'blind_review' || r.seat === 'senior_review').map(({ seat, mode }) => ({ seat, mode }))

test('D1 an outside plan runs blind_review before senior, unsent', async () => {
  const sent: string[] = []
  const w = await outside(stub(CARRIED), sent)
  expect(fifth(w, 1)).toEqual([{ seat: 'blind_review', mode: 'review' }, { seat: 'senior_review', mode: null }])
  expect(sent.filter((l) => /^(send|open) /.test(l) && !l.endsWith('-next'))).toEqual([])
})

test('D2 an internal plan at step 5 runs no blind_review', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, 'export const two = 2')
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  expect(fifth(w, MINE)).toEqual([{ seat: 'senior_review', mode: null }])
})

test('D3 a blind refuse leaves step 5 to senior', async () => {
  const w = await outside(blindly(REFUSE))
  expect(plan(w.db, 1).step).toBe(6)
  expect(verdictRows(w.db, 1).find((v) => v.gate === 'blind_review')).toMatchObject({ step: 5, outcome: 'refuse' })
})

test('D4 a blind reply with no fence is logged and senior judges', async () => {
  const w = await outside(blindly('no fence here'))
  expect(eventsOf(w.db, 1, 'senior')).toContainEqual({ actor: 'blind_review', outcome: 'refuse', message: 'Error: reviewers.verdict_fence' })
  expect(verdictRows(w.db, 1).find((v) => v.gate === 'senior_review')).toMatchObject({ step: 5, outcome: 'pass' })
})

test('D3 senior re-reads from its own tree, not the blind one', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE), undefined, undefined, wire)
  rewind(w.db, 1, 2)
  built(w.root, 1, 'export const five = 5')
  const seen: string[] = []
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p.prompt)), undefined, undefined, wire)
  expect(seen.findLast((p) => p.includes('# senior_review'))?.split('# Changed since your last verdict')[1]).toContain('five = 5')
})
