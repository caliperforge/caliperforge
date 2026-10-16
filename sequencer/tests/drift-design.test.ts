import { expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { addRule, type Db } from '../../store/index.ts'
import { addPlan, type PlanRow } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const design = REGISTRY.filter((e) => e.name === 'design')

const atelier = (d: Db, issue: number, step: number, state: PlanRow['state'] = 'running'): number => addPlan(d, { pipe_id: 1, target_id: null,
  template: 'pr_path', state, queued_at: '2026-10-01', lane: 'loupe', seat: 'web_specialist',
  origin: `https://github.com/caliperforge/atelier-web/issues/${String(issue)}`, step })

test('D6 design is silent only once atelier-web is past step 4', () => {
  const d = db()
  expect(drift(d, design, NOW)).toEqual([])
  atelier(d, 1, 4)
  expect(drift(d, design, NOW)).toEqual([])
  atelier(d, 2, 5)
  expect(drift(d, design, NOW)).toEqual([{ name: 'design', state: 'silent', detail: "no row in runs WHERE seat = 'design_lead'" }])
})

test('D2 a design_lead plan past step 4 leaves design quiet', () => {
  const d = db()
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-01', lane: 'loupe',
    seat: 'design_lead', origin: 'https://github.com/caliperforge/atelier-web/issues/1', step: 5 })
  expect(drift(d, design, NOW)).toEqual([])
})

test('design ignores a done atelier-web plan', () => {
  const d = db()
  atelier(d, 1, 9, 'done')
  expect(drift(d, design, NOW)).toEqual([])
})

test('a design_lead run clears the design finding', () => {
  const d = db()
  const plan = atelier(d, 1, 5)
  addRule(d, { id: 'design_lead', kind: 'card', path: 'rules/roster/design_lead.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-10-01' })
  addRun(d, { plan, step: 5, seat: 'design_lead', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
    at: '2026-10-02 10:00:00', transcript_path: 'x.transcript.jsonl', cost_usd: null })
  expect(drift(d, design, NOW)).toEqual([])
})
