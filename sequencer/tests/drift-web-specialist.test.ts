import { expect, test } from 'vitest'
import { addPlan } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D4 web_specialist is silent only once atelier-web has a plan', () => {
  const web = REGISTRY.filter((e) => e.name === 'web_specialist')
  const d = db()
  expect(drift(d, web, NOW)).toEqual([])
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-01', lane: 'atelier',
    seat: 'web_specialist', origin: 'https://github.com/caliperforge/atelier-web/issues/1', step: 0 })
  expect(drift(d, web, NOW)).toEqual([{ name: 'web_specialist', state: 'silent', detail: "no row in runs WHERE seat = 'web_specialist'" }])
})
