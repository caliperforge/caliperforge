import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import type { Packet } from '../../kind.ts'
import { gate } from '../index.ts'

const cwd = mkdtempSync(join(tmpdir(), 'cf-ranged-'))

const packet = (ranged?: boolean): Packet => ({ prompt: '', cwd, transcript: join(cwd, 't.jsonl'), model: 'm', effort: 'high', tools: ['Read'],
  refuse: () => null, ...(ranged === undefined ? {} : { ranged }) })

const read = (input: Record<string, unknown>): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd })

test('D1: a ranged packet denies a whole src or lib .sol read', () => {
  for (const file_path of ['src/X.sol', join(cwd, 'src/X.sol'), 'lib/forge-std/src/Test.sol']) {
    expect(gate(packet(true), read({ file_path }))).toMatchObject({
      continue: true,
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('run.whole_read') as string },
    })
  }
})

test('D2: a ranged read, a test .sol and a .ts pass', () => {
  for (const input of [{ file_path: 'src/X.sol', offset: 10 }, { file_path: 'src/X.sol', limit: 40 }, { file_path: 'test/fizz/P.sol' }, { file_path: 'src/X.ts' }]) {
    expect(gate(packet(true), read(input))).toEqual({ continue: true })
  }
})

test('D3: an unflagged packet reads a whole .sol', () => {
  expect(gate(packet(), read({ file_path: 'src/X.sol' }))).toEqual({ continue: true })
})
