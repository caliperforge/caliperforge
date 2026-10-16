import { expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { addRule, type Db } from '../../store/index.ts'
import { addPlan } from '../../store/plans.ts'
import { recordListing, type Listing } from '../../store/tickets.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const ATELIER = 'caliperforge/atelier-web'

const LEAD = REGISTRY.filter((e) => e.name === 'design_lead')

const ticket = (number: number, labels: string[], closedAt: string | null = null): Listing => ({
  number, title: `issue ${String(number)}`, body: 'the ask', url: `https://github.com/${ATELIER}/issues/${String(number)}`,
  labels: labels.map((name) => ({ name })), createdAt: '2026-09-01T09:00:00Z', closedAt, stateReason: null,
})

function ran(d: Db): void {
  addRule(d, { id: 'design_lead', kind: 'card', path: 'rules/roster/design_lead.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-01' })
  addRun(d, { plan: 1, step: 1, seat: 'design_lead', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
    at: '2026-09-15 10:00:00', transcript_path: 'x.transcript.jsonl', cost_usd: null })
}

test('D2 an open wave ticket and an old run go stale', () => {
  const d = db()
  recordListing(d, ATELIER, [ticket(1, ['lane:loupe', 'wave:1'])], false)
  ran(d)
  expect(drift(d, LEAD, NOW)).toEqual([{ name: 'design_lead', state: 'stale', detail: 'newest runs.at is 2026-09-15 10:00:00, older than 14d',
    newest: '2026-09-15 10:00:00' }])
})

test('D3 no open wave ticket reports nothing', () => {
  const d = db()
  recordListing(d, ATELIER, [ticket(1, ['lane:loupe', 'wave:1'], '2026-09-20T09:00:00Z'), ticket(2, ['lane:loupe'])], false)
  addPlan(d, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-01', lane: 'loupe',
    seat: 'web_specialist', origin: `https://github.com/${ATELIER}/issues/2`, step: 3 })
  ran(d)
  expect(drift(d, LEAD, NOW)).toEqual([])
})

test('D4 an open wave ticket waits for the first run', () => {
  const d = db()
  recordListing(d, ATELIER, [ticket(1, ['lane:loupe', 'wave:1'])], false)
  expect(drift(d, LEAD, NOW)).toEqual([])
})
