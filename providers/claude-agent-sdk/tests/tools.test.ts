import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpSdkServerConfigWithInstance, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

const sent: Record<string, unknown>[] = []

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [], result: '',
  usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sent.push(options)
    return { [Symbol.asyncIterator]: () => [RESULT][Symbol.iterator]() }
  },
}))

const { claudeAgentSdk, fired } = await import('../index.ts')

function packet(tools: string[]): Packet {
  return {
    prompt: 'p',
    cwd: '/tmp',
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-tools-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5-5',
    effort: 'high',
    tools,
    refuse: () => null,
  }
}

/** The measured defect: the reviewer was offered Bash, opened on `git log`, and the gate ended the run. */
test('a reviewer packet offers only the tools its manifest names', async () => {
  await claudeAgentSdk.fire(packet(['Read', 'Glob', 'Grep']))
  expect(sent.at(-1)?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(sent.at(-1)?.allowedTools).toEqual(['Read', 'Glob', 'Grep'])
})

test('steps become maxTurns, and no steps sends none', async () => {
  await claudeAgentSdk.fire({ ...packet(['Read']), steps: 3 })
  expect(sent.at(-1)?.maxTurns).toBe(3)
  await claudeAgentSdk.fire(packet(['Read']))
  expect(sent.at(-1)).not.toHaveProperty('maxTurns')
})

test('servers become mcpServers, and no servers sends none', async () => {
  const servers = { github: {} as McpSdkServerConfigWithInstance }
  await claudeAgentSdk.fire({ ...packet(['Read', 'mcp__github__read']), servers })
  expect(sent.at(-1)?.mcpServers).toBe(servers)
  expect(sent.at(-1)?.tools).toEqual(['Read', 'mcp__github__read'])
  await claudeAgentSdk.fire(packet(['Read']))
  expect(sent.at(-1)).not.toHaveProperty('mcpServers')
})

test('Bash is offered once, bare; patterns stay on allowedTools', async () => {
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(gradle:*)', 'Bash(./gradlew:*)']
  await claudeAgentSdk.fire(packet(tools))
  expect(sent.at(-1)?.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'])
  expect(sent.at(-1)?.allowedTools).toEqual(tools)
})

test('D5 Agent is offered and allowed', async () => {
  await claudeAgentSdk.fire(packet(['Read', 'Edit', 'Agent', 'Bash(forge:*)']))
  expect(sent.at(-1)?.tools).toEqual(['Read', 'Edit', 'Agent', 'Bash'])
  expect(sent.at(-1)?.allowedTools).toEqual(['Read', 'Edit', 'Agent', 'Bash(forge:*)'])
})

test('D6 fired sums every model in modelUsage', () => {
  const used = (n: number) => ({ inputTokens: n, cacheCreationInputTokens: 10, cacheReadInputTokens: 5, outputTokens: n * 2 })
  const result = { ...RESULT, modelUsage: { 'claude-opus-5-5': used(100), 'claude-sonnet-5': used(40) } } as unknown as SDKResultMessage
  expect(fired(result, Date.now(), []).usage).toMatchObject({ input: 160, cache: 10, write: 20, output: 280 })
})
