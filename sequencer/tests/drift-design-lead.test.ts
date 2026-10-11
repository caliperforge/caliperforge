import { expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { addRule } from '../../store/index.ts'
import { addPlan } from '../../store/plans.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D6 design_lead waits for its first run, then goes stale', () => {
  const lead = REGISTRY.filter((e) => e.name === 'design_lead')
  const d = db()
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-01', lane: 'atelier',
    seat: 'web_specialist', origin: 'https://github.com/caliperforge/atelier-web/issues/1', step: 3 })
  expect(drift(d, lead, NOW)).toEqual([])
  addRule(d, { id: 'design_lead', kind: 'card', path: 'rules/roster/design_lead.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-01' })
  addRun(d, { plan: 1, step: 1, seat: 'design_lead', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
    at: '2026-09-15 10:00:00', transcript_path: 'x.transcript.jsonl', cost_usd: null })
  expect(drift(d, lead, NOW)).toEqual([{ name: 'design_lead', state: 'stale', detail: 'newest runs.at is 2026-09-15 10:00:00, older than 14d',
    newest: '2026-09-15 10:00:00' }])
})
