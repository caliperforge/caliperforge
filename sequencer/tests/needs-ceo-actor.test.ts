import { expect, test } from 'vitest'
import { allEvents, logged } from '../../store/events.ts'
import { putPlan } from '../../store/plans.ts'
import { addTarget } from '../../store/targets.ts'
import { drift } from '../drift.ts'
import { tick } from '../index.ts'
import { REGISTRY } from './drifting.ts'
import { approve, CARRIED, stub, watched, WORDS, world } from './world.ts'

const LINE = REGISTRY.filter((e) => e.name === 'needs_ceo_actor')

test('only the coo writes needs_ceo across the three stops', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  await tick(w.db, w.root, stub(CARRIED, 0, `${WORDS}\n\n---\noutcome: needs_ceo\n---\n`))
  const day = new Date().toISOString().slice(0, 10)
  addTarget(w.db, { account_id: 1, repo: 'acme/widget', issue_no: 13, named_merger: 'maintainer', state: 'parked',
    evidence_measured_at: day, evidence: 'https://github.com/acme/widget/issues/13' })
  putPlan(w.db, { id: 2, pipe_id: 1, target_id: 2, template: 'pr_path', state: 'running', queued_at: `${day}T00:00:00.000Z`, step: 2, retries: 0 })
  const t = Date.now()
  const later = new Date(t + 61 * 60_000)
  for (const now of [new Date(t), new Date(t + 30 * 60_000), later]) {
    await tick(w.db, w.root, stub(CARRIED), now, undefined, undefined, 0, undefined, Infinity, undefined, undefined, [{ name: 'stuck_plans', gap: '1h' }])
  }
  const stops = allEvents(w.db).filter((e) => e.outcome === 'escalate' || e.outcome === 'needs_coo')
  expect(stops.map((e) => [e.actor, e.outcome])).toEqual(expect.arrayContaining([['code_quality', 'escalate'], ['director', 'needs_coo'], ['drift', 'escalate']]))
  expect(allEvents(w.db).filter((e) => e.outcome === 'needs_ceo' && e.actor !== 'coo')).toEqual([])
  expect(drift(w.db, LINE, later)).toEqual([])
  const at = new Date(later.getTime() - 3_600_000).toISOString()
  logged(w.db, { plan: 1, kind: 'director', actor: 'coo', outcome: 'needs_ceo', message: 'm', pointer: null, run: null }, at)
  expect(drift(w.db, LINE, later)).toEqual([])
  logged(w.db, { plan: 1, kind: 'review', actor: 'code_quality', outcome: 'needs_ceo', message: 'm', pointer: null, run: null }, at)
  expect(drift(w.db, LINE, later)).toEqual([{ name: 'needs_ceo_actor', state: 'seen', detail: `newest events.at is ${at}, within 7d; expected none` }])
})
