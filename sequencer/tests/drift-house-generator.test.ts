import { expect, test } from 'vitest'
import { record } from '../../store/bench.ts'
import { addRun } from '../../store/brief.ts'
import { addRule, type Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const HOUSE = REGISTRY.filter((e) => e.name === 'house_generator')

function scored(d: Db, generator: string): void {
  record(d, { plan: 1, target: 'a/b', generator, catches: 1, false_positives: 0, untested: 0, tokens: 0, seconds: 1, x_ray: null })
}

test('D2 a house scorecard row with no run is silent', () => {
  const d = db()
  scored(d, 'house_generator')
  expect(drift(d, HOUSE, NOW)).toEqual([{ name: 'house_generator', state: 'silent', detail: "no row in runs WHERE seat = 'house_generator'" }])
})

test('D3 no house scorecard row reports nothing', () => {
  const d = db()
  expect(drift(d, HOUSE, NOW)).toEqual([])
  scored(d, 'fizz_generator')
  expect(drift(d, HOUSE, NOW)).toEqual([])
})

test('D4 a house_generator run keeps it quiet', () => {
  const d = db()
  scored(d, 'house_generator')
  addRule(d, { id: 'house_generator', kind: 'card', path: 'rules/roster/house_generator.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-01' })
  addRun(d, { plan: 1, step: 1, seat: 'house_generator', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
    at: '2026-09-15 10:00:00', transcript_path: 'x.transcript.jsonl', cost_usd: null })
  expect(drift(d, HOUSE, NOW)).toEqual([])
})
