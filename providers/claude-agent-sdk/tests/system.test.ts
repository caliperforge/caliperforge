import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

const sent: { prompt: string; options: Record<string, unknown> }[] = []

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [], result: '',
  usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (call: { prompt: string; options: Record<string, unknown> }) => {
    sent.push(call)
    return { [Symbol.asyncIterator]: () => [RESULT][Symbol.iterator]() }
  },
}))

const { claudeAgentSdk, readOutside } = await import('../index.ts')

function packet(cwd: string, plan: string): Packet {
  return {
    prompt: 'p',
    cwd,
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-system-')), plan, 'run.transcript.jsonl'),
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: ['Read'],
    refuse: () => null,
  }
}

test('runs get the claude_code preset without dynamic sections', async () => {
  await claudeAgentSdk.fire(packet('/tmp/a/src', '1'))
  expect(sent.at(-1)?.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', excludeDynamicSections: true })
})

test('different folders and plans get one system prompt', async () => {
  await claudeAgentSdk.fire(packet('/tmp/a/src', '1'))
  await claudeAgentSdk.fire(packet('/tmp/b/src', '2'))
  expect(sent.at(-1)?.options.systemPrompt).toEqual(sent.at(-2)?.options.systemPrompt)
})

test('working folder ends the prompt, a read outside is refused', async () => {
  await claudeAgentSdk.fire(packet('/tmp/a/src', '1'))
  expect(sent.at(-1)?.prompt.endsWith('# Working folder\n\n/tmp/a/src')).toBe(true)
  expect(readOutside('/tmp/a/src', 'Read', { file_path: '/tmp/b/x.ts' })).toMatch(/^ruling:run\.outside_checkout/)
})
