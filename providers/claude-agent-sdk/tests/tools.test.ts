import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

const sent: Record<string, unknown>[] = []

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [], result: '' }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    sent.push(options)
    return { [Symbol.asyncIterator]: () => [RESULT][Symbol.iterator]() }
  },
}))

const { claudeAgentSdk } = await import('../index.ts')

function packet(tools: string[]): Packet {
  return {
    prompt: 'p',
    cwd: '/tmp',
    transcript: join(mkdtempSync(join(tmpdir(), 'cf-tools-')), 'run.transcript.jsonl'),
    model: 'claude-opus-5',
    effort: 'high',
    tools,
    refuse: () => null,
  }
}

/** The measured defect of kernel #29: the reviewer was offered Bash, opened on `git log`, and the gate ended the run. */
test('a reviewer packet offers only the three tools its manifest names', async () => {
  await claudeAgentSdk.fire(packet(['Read', 'Glob', 'Grep']))
  expect(sent.at(-1)?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(sent.at(-1)?.allowedTools).toEqual(['Read', 'Glob', 'Grep'])
})

test('a packet carrying steps sends them as the query turn limit, and one without sends none', async () => {
  await claudeAgentSdk.fire({ ...packet(['Read']), steps: 3 })
  expect(sent.at(-1)?.maxTurns).toBe(3)
  await claudeAgentSdk.fire(packet(['Read']))
  expect(sent.at(-1)).not.toHaveProperty('maxTurns')
})

test('a builder packet offers Bash once, under its bare name, and the patterns stay on allowedTools', async () => {
  const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(gradle:*)', 'Bash(./gradlew:*)']
  await claudeAgentSdk.fire(packet(tools))
  expect(sent.at(-1)?.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'])
  expect(sent.at(-1)?.allowedTools).toEqual(tools)
})
