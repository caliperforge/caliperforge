import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, test } from 'vitest'
import { ranges } from '../../../templates/map.ts'
import type { Packet } from '../../kind.ts'
import { gate } from '../index.ts'
import { judged } from '../read.ts'

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

const V = [{ file: 'src/V.sol', start: 120, end: 140 }]

const map = { ranges: V, slice: V }

test('map D1: a read within 20 lines of a range is no miss', () => {
  expect(judged(map, cwd, 'Read', { file_path: 'src/V.sol', offset: 110, limit: 41 })).toBeNull()
  expect(judged(map, cwd, 'Read', { file_path: 'src/V.sol', offset: 100, limit: 61 })).toBeNull()
})

test('map D2: a read past the margin or unlimited is a map miss', () => {
  expect(judged(map, cwd, 'Read', { file_path: 'src/V.sol', offset: 300, limit: 21 })).toEqual({ kind: 'read.map_miss', file: 'src/V.sol', lines: 'L300-L320' })
  expect(judged(map, cwd, 'Read', { file_path: 'src/V.sol', offset: 99, limit: 42 })).toMatchObject({ kind: 'read.map_miss', lines: 'L99-L140' })
  expect(judged(map, cwd, 'Read', { file_path: 'src/V.sol' })).toEqual({ kind: 'read.map_miss', file: 'src/V.sol', lines: 'L1-end' })
  expect(judged(map, cwd, 'Read', { file_path: 'src/W.sol', offset: 120, limit: 21 })).toMatchObject({ kind: 'read.map_miss', file: 'src/W.sol' })
})

test('map D3: a mapped read outside the slice is a slice miss', () => {
  const sliced = { ranges: V, slice: [{ file: 'src/V.sol', start: 200, end: 220 }] }
  expect(judged(sliced, cwd, 'Read', { file_path: 'src/V.sol', offset: 120, limit: 21 })).toEqual({ kind: 'read.slice_miss', file: 'src/V.sol', lines: 'L120-L140' })
})

test('map D4: a test .sol, a .ts and other tools are not judged', () => {
  expect(judged(map, cwd, 'Read', { file_path: 'test/fizz/P.sol' })).toBeNull()
  expect(judged(map, cwd, 'Read', { file_path: 'src/X.ts' })).toBeNull()
  expect(judged(map, cwd, 'Grep', { path: 'src/V.sol' })).toBeNull()
})

test('map D5: a mapped packet is never denied a whole read', () => {
  expect(gate({ ...packet(true), map }, read({ file_path: 'src/X.sol' }))).toEqual({ continue: true })
  expect(gate(packet(true), read({ file_path: 'src/X.sol' }))).toMatchObject({
    hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('run.whole_read') as string },
  })
})

test('map D7: ranges reads each at: cell and skips none', () => {
  const text = '## Signatures\n\n- X.f() | at: src/V.sol L120-L140\n- Y | at: src/V.sol L9-L9\n\n## Modifiers\n\n- none\n'
  expect(ranges(text)).toEqual([{ file: 'src/V.sol', start: 120, end: 140 }, { file: 'src/V.sol', start: 9, end: 9 }])
})
