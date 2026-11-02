import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

type Hook = (input: unknown) => Promise<{ continue: boolean }>

const decisions: { continue: boolean }[] = []

const READS = [{ offset: 300, limit: 21 }, { offset: 120, limit: 21 }, {}].map((at) =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/V.sol', ...at } }))

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn',
  modelUsage: {}, permission_denials: [], result: 'done', usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { hooks: { PreToolUse: { hooks: Hook[] }[] } } }) => {
    const hook = options.hooks.PreToolUse[0]?.hooks[0]
    if (hook === undefined) throw new Error('no PreToolUse hook')
    return {
      async *[Symbol.asyncIterator]() {
        for (const call of READS) decisions.push(await hook(call))
        yield RESULT
      },
    }
  },
}))

const { claudeAgentSdk } = await import('../index.ts')

function packet(): Packet {
  const cwd = mkdtempSync(join(tmpdir(), 'cf-misses-'))
  return { prompt: 'p', cwd, transcript: join(cwd, 'run.transcript.jsonl'), model: 'claude-opus-5-5', effort: 'high', tools: ['Read'], refuse: () => null }
}

test('D6 a mapped run returns one miss per out-of-map read', async () => {
  const V = [{ file: 'src/V.sol', start: 120, end: 140 }]
  const fired = await claudeAgentSdk.fire({ ...packet(), ranged: true, map: { ranges: V, slice: V } })
  expect(fired.misses).toEqual([
    { kind: 'read.map_miss', file: 'src/V.sol', lines: 'L300-L320' },
    { kind: 'read.map_miss', file: 'src/V.sol', lines: 'L1-end' },
  ])
  expect(decisions).toEqual([{ continue: true }, { continue: true }, { continue: true }])
})

test('D6 an unmapped run returns no misses key', async () => {
  expect(await claudeAgentSdk.fire(packet())).not.toHaveProperty('misses')
})
