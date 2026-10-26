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

const run = { writes: 1 }

const TURN = { type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } }

const CALL = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/helper.ts' } }

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  modelUsage: {}, permission_denials: [], result: 'done', usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

/** The SDK as far as the fence is concerned: a turn, then a write outside it. */
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { hooks: { PreToolUse: { hooks: Hook[] }[] } } }) => {
    const hook = options.hooks.PreToolUse[0]?.hooks[0]
    if (hook === undefined) throw new Error('no PreToolUse hook')
    return {
      async *[Symbol.asyncIterator]() {
        for (let at = 0; at < run.writes; at += 1) {
          yield TURN
          const decision = await hook(CALL)
          decisions.push(decision)
          if (!decision.continue) break
        }
        yield RESULT
      },
    }
  },
}))

const { claudeAgentSdk } = await import('../index.ts')

function packet(): Packet {
  return {
    prompt: 'p',
    cwd: '/tmp',
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-fence-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: ['Write'],
    refuse: (path) => ({ origin_kind: 'ruling', origin_ref: 'seat.write_paths', path }),
  }
}

async function fire(writes: number, p: Packet = packet()): Promise<Awaited<ReturnType<typeof claudeAgentSdk.fire>>> {
  decisions.length = 0
  run.writes = writes
  return claudeAgentSdk.fire(p)
}

test('D3 one outside write is denied and the run completes', async () => {
  const fired = await fire(1)
  expect(decisions).toMatchObject([{ continue: true, hookSpecificOutput: { permissionDecision: 'deny' } }])
  expect(fired).toMatchObject({ exit: 0, ended: 'completed' })
})

test('D2 the fifth outside write stops the run', async () => {
  const fired = await fire(5)
  expect(decisions.map((d) => d.continue)).toEqual([true, true, true, true, false])
  expect(fired.stop_reason).toContain('seat.write_paths')
  expect(fired).toMatchObject({ exit: 1, ended: 'stopped' })
})

test('D4 a denied write still trips the idle limit', async () => {
  const fired = await fire(3, { ...packet(), tools: ['Read', 'Write'], idle: 2 })
  expect(decisions.map((d) => d.continue)).toEqual([true, false])
  expect(fired.stop_reason).toContain('run.idle')
})

test('D5 a second run on one packet counts from zero', async () => {
  const p = packet()
  await fire(5, p)
  const fired = await fire(1, p)
  expect(decisions.map((d) => d.continue)).toEqual([true])
  expect(fired.exit).toBe(0)
})
