import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'

/** As plan 65's last run logged it on 2026-09-21, 12:09 Guatemala. */
const INFO = {
  status: 'allowed_warning', resetsAt: 1790222400, rateLimitType: 'seven_day', utilization: 0.83,
  isUsingOverage: false, surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1790018400 }, seven_day: { utilization: 0.83, resetsAt: 1790222400 } },
} as SDKRateLimitInfo

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [], result: '' }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({ [Symbol.asyncIterator]: () => [{ type: 'rate_limit_event', rate_limit_info: INFO }, RESULT][Symbol.iterator]() }),
}))

const { claudeAgentSdk, readings } = await import('../index.ts')

const AT = '2026-09-21T18:09:44.000Z'

test('both windows from one event', () => {
  expect(readings(INFO, AT)).toEqual([
    { observed_at: AT, rate_limit_type: 'five_hour', resets_at: 1790018400, status: 'allowed', utilization: 0.06 },
    { observed_at: AT, rate_limit_type: 'seven_day', resets_at: 1790222400, status: 'allowed_warning', utilization: 0.83 },
  ])
})

test('the named window alone, and none from an overage event', () => {
  const bare = { status: 'allowed', resetsAt: 1790018400, rateLimitType: 'five_hour', utilization: 0.2 } as SDKRateLimitInfo
  expect(readings(bare, AT)).toEqual([{ observed_at: AT, rate_limit_type: 'five_hour', resets_at: 1790018400, status: 'allowed', utilization: 0.2 }])
  expect(readings({ status: 'allowed', rateLimitType: 'overage' }, AT)).toEqual([])
})

test('a run brings its readings back', async () => {
  const fired = await claudeAgentSdk.fire({
    prompt: 'p', cwd: '/tmp', transcript: join(mkdtempSync(join(tmpdir(), 'cf-limits-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5', effort: 'high', tools: ['Read'], refuse: () => null,
  })
  expect(fired.limits?.map((r) => [r.rate_limit_type, r.utilization])).toEqual([['five_hour', 0.06], ['seven_day', 0.83]])
})
