import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { addPlan, type PlanRow } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const web = REGISTRY.filter((e) => e.name === 'web_specialist')
const SILENT = [{ name: 'web_specialist', state: 'silent', detail: "no row in runs WHERE seat = 'web_specialist'" }]

function planned(d: Db, state: PlanRow['state'], queued_at: string): Db {
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state, queued_at, lane: 'atelier',
    seat: 'web_specialist', origin: 'https://github.com/caliperforge/atelier-web/issues/1', step: 0 })
  return d
}

test('D4 web_specialist is silent only once atelier-web has a plan', () => {
  const d = db()
  expect(drift(d, web, NOW)).toEqual([])
  expect(drift(planned(d, 'queued', '2026-10-01'), web, NOW)).toEqual(SILENT)
})

test('D1 a refused atelier-web plan does not make it silent', () => {
  expect(drift(planned(db(), 'refused', '2026-10-02'), web, NOW)).toEqual([])
})

test('D2 an atelier-web plan queued 8 days back is not silent', () => {
  expect(drift(planned(db(), 'queued', '2026-09-25'), web, NOW)).toEqual([])
})

test('D3 an atelier-web plan queued yesterday is silent', () => {
  expect(drift(planned(db(), 'queued', '2026-10-02'), web, NOW)).toEqual(SILENT)
})
