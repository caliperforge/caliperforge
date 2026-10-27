import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { CostWall, Packet } from '../../kind.ts'

interface Decision {
  continue: boolean
  stopReason?: string
}

type Hook = (input: unknown) => Promise<Decision>

const decisions: Decision[] = []

const TURNS = 4

const PER_TURN = 2_000_000

const spend = { read: false }

const turn = (n: number): unknown => ({
  type: 'assistant',
  message: { usage: spend.read
    ? { input_tokens: 0, cache_read_input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 0 }
    : { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
})

const CALL = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x.ts' } }

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  modelUsage: {}, permission_denials: [], result: 'done', usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

/** The SDK as far as the wall is concerned: a turn, then the tool call that would buy the next one. */
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { hooks: { PreToolUse: { hooks: Hook[] }[] } } }) => {
    const hook = options.hooks.PreToolUse[0]?.hooks[0]
    if (hook === undefined) throw new Error('no PreToolUse hook')
    return {
      async *[Symbol.asyncIterator]() {
        for (let at = 0; at < TURNS; at += 1) {
          yield turn(PER_TURN)
          const decision = await hook(CALL)
          decisions.push(decision)
          if (!decision.continue) break
        }
        yield RESULT
      },
    }
  },
}))

const { claudeAgentSdk, costWalled, priced, walled } = await import('../index.ts')

const priceOf = (cache_read: number): CostWall => ({ usd: 25, input: 0, cache_write: 0, cache_write_1h: 0, cache_read, output: 0 })

function packet(): Packet {
  return {
    prompt: 'p',
    cwd: '/tmp',
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-wall-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: ['Read'],
    refuse: () => null,
  }
}

test('a run past its wall stops at the next call, naming the wall', async () => {
  decisions.length = 0
  const fired = await claudeAgentSdk.fire({ ...packet(), wall: 5_000_000 })

  expect(decisions.map((d) => d.continue)).toEqual([true, true, false])
  expect(decisions.at(-1)?.stopReason).toBe('ruling:run.token_wall stopped the run at 6.0M tokens, past the 5.0M wall')
  expect(fired.stop_reason).toContain('run.token_wall')
  expect(fired.exit).toBe(1)
  expect(fired.denials).toBe(1)
})

test('cache reads never reach the wall', async () => {
  decisions.length = 0
  spend.read = true
  const fired = await claudeAgentSdk.fire({ ...packet(), wall: 5_000_000 })
  spend.read = false

  expect(decisions.map((d) => d.continue)).toEqual([true, true, true, true])
  expect(fired.exit).toBe(0)
})

test('a packet with no wall runs every turn it was going to run', async () => {
  decisions.length = 0
  const fired = await claudeAgentSdk.fire(packet())

  expect(decisions.map((d) => d.continue)).toEqual([true, true, true, true])
  expect(fired.exit).toBe(0)
})

test('a wall stops at spent-or-past, an absent wall never does', () => {
  expect(walled(undefined, 9_000_000)).toBeNull()
  expect(walled(5_000_000, 4_999_999)).toBeNull()
  expect(walled(5_000_000, 5_000_000)).toContain('past the 5.0M wall')
})

test('cache reads past the cost wall stop the run', async () => {
  decisions.length = 0
  spend.read = true
  const fired = await claudeAgentSdk.fire({ ...packet(), wall: 6_000_000, cost_wall: priceOf(5) })
  spend.read = false

  expect(decisions.map((d) => d.continue)).toEqual([true, true, false])
  expect(decisions.at(-1)?.stopReason).toBe('ruling:run.cost_wall stopped the run at $30.00, past the $25 wall')
  expect(fired.stop_reason).toContain('run.cost_wall')
  expect(fired.exit).toBe(1)
})

test('a run under its cost wall runs every turn', async () => {
  decisions.length = 0
  spend.read = true
  const fired = await claudeAgentSdk.fire({ ...packet(), wall: 6_000_000, cost_wall: priceOf(1) })
  spend.read = false

  expect(decisions.map((d) => d.continue)).toEqual([true, true, true, true])
  expect(fired.exit).toBe(0)
})

test('a cost wall stops at spent-or-past, an absent one never', () => {
  expect(costWalled(undefined, 1000)).toBeNull()
  expect(costWalled(priceOf(1), 24.99)).toBeNull()
  expect(costWalled(priceOf(1), 25)).toContain('past the $25 wall')
})

test('priced charges each token class at its own price', () => {
  const message = { type: 'assistant', message: { usage: {
    input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 4e5 },
    cache_read_input_tokens: 1e6, output_tokens: 1e6,
  } } } as unknown as Parameters<typeof priced>[0]
  const wall = { usd: 25, input: 5, cache_write: 6.25, cache_write_1h: 10, cache_read: 0.5, output: 25 }

  expect(priced(message, wall)).toBe(38.25)
})
