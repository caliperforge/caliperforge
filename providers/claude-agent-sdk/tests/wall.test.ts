import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

interface Decision {
  continue: boolean
  stopReason?: string
}

type Hook = (input: unknown) => Promise<Decision>

const decisions: Decision[] = []

const TURNS = 4

const PER_TURN = 2_000_000

const turn = (n: number): unknown => ({
  type: 'assistant',
  message: { usage: { input_tokens: 0, cache_read_input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 0 } },
})

const CALL = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x.ts' } }

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  modelUsage: {}, permission_denials: [], result: 'done' }

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

const { claudeAgentSdk, walled } = await import('../index.ts')

function packet(): Packet {
  return {
    prompt: 'p',
    cwd: '/tmp',
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-wall-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5',
    effort: 'high',
    tools: ['Read'],
    refuse: () => null,
  }
}

test('a run past its wall stops before the next model call, and the row says which wall', async () => {
  decisions.length = 0
  const fired = await claudeAgentSdk.fire({ ...packet(), wall: 5_000_000 })

  expect(decisions.map((d) => d.continue)).toEqual([true, true, false])
  expect(decisions.at(-1)?.stopReason).toBe('ruling:run.token_wall stopped the run at 6.0M tokens, past the 5.0M wall')
  expect(fired.stop_reason).toContain('run.token_wall')
  expect(fired.exit).toBe(1)
  expect(fired.denials).toBe(1)
})

test('a packet with no wall runs every turn it was going to run', async () => {
  decisions.length = 0
  const fired = await claudeAgentSdk.fire(packet())

  expect(decisions.map((d) => d.continue)).toEqual([true, true, true, true])
  expect(fired.exit).toBe(0)
})

test('the wall is read as spent-or-past, and an absent wall never stops a run', () => {
  expect(walled(undefined, 9_000_000)).toBeNull()
  expect(walled(5_000_000, 4_999_999)).toBeNull()
  expect(walled(5_000_000, 5_000_000)).toContain('past the 5.0M wall')
})
