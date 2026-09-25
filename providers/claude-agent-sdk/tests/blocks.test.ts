import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

interface Decision {
  continue: boolean
}

type Hook = (input: unknown) => Promise<Decision>

const decisions: Decision[] = []

/** One turn as the SDK streams it: a message per content block, each with the whole turn's usage. */
const block = (id: string): unknown => ({
  type: 'assistant',
  message: { id, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 150_000, output_tokens: 0 } },
})

const CALL = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x.ts' } }

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  modelUsage: {}, permission_denials: [], result: 'done' }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { hooks: { PreToolUse: { hooks: Hook[] }[] } } }) => {
    const hook = options.hooks.PreToolUse[0]?.hooks[0]
    if (hook === undefined) throw new Error('no PreToolUse hook')
    return {
      async *[Symbol.asyncIterator]() {
        for (const id of ['msg_1', 'msg_2']) {
          for (let b = 0; b < 4; b += 1) yield block(id)
          decisions.push(await hook(CALL))
        }
        yield RESULT
      },
    }
  },
}))

const { claudeAgentSdk } = await import('../index.ts')

test('a turn streamed as four blocks counts once against the wall', async () => {
  decisions.length = 0
  await claudeAgentSdk.fire({
    prompt: 'p', cwd: '/tmp', model: 'claude-opus-5-5', effort: 'high', tools: ['Read'], refuse: () => null,
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-blocks-')), 'run.transcript.jsonl'), wall: 400_000,
  })
  expect(decisions.map((d) => d.continue)).toEqual([true, true])
})
