import { expect, test } from 'vitest'
import { runLogged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { addPlan, type PlanRow } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const web = REGISTRY.filter((e) => e.name === 'web_specialist')
const SILENT = [{ name: 'web_specialist', state: 'silent', detail: "no row in runs WHERE staffed = 'web_specialist'" }]

function ran(d: Db, seat: string, staffed?: string): Db {
  addRule(d, { id: seat, kind: 'card', path: `rules/roster/${seat}.yaml`, content_hash: 'a'.repeat(64), loaded_at: '2026-09-01' })
  runLogged(d, { plan: 1, step: 1, seat, rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'low', exit: 0,
    fired: { usage: { input: 0, cache: 0, output: 0 }, seconds: 0, transcript_path: 't.transcript.jsonl' }, staffed })
  return d
}

function planned(d: Db, state: PlanRow['state'], queued_at: string): Db {
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state, queued_at, lane: 'loupe',
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

test('D2 a design_lead run staffed web_specialist is not silent', () => {
  expect(drift(ran(planned(db(), 'queued', '2026-10-02'), 'design_lead', 'web_specialist'), web, NOW)).toEqual([])
})

test('D3 a web_specialist seat with no staffed is still silent', () => {
  expect(drift(ran(planned(db(), 'queued', '2026-10-02'), 'web_specialist'), web, NOW)).toEqual(SILENT)
})
