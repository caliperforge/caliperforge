import { expect, test } from 'vitest'
import { addPlan } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D6 design is silent only once atelier-web is past step 4', () => {
  const design = REGISTRY.filter((e) => e.name === 'design')
  const d = db()
  expect(drift(d, design, NOW)).toEqual([])
  const running = (issue: number, step: number): number => addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running',
    queued_at: '2026-10-01', lane: 'atelier', seat: 'web_specialist', origin: `https://github.com/caliperforge/atelier-web/issues/${String(issue)}`, step })
  running(1, 4)
  expect(drift(d, design, NOW)).toEqual([])
  running(2, 5)
  expect(drift(d, design, NOW)).toEqual([{ name: 'design', state: 'silent', detail: "no row in runs WHERE seat = 'design'" }])
})
