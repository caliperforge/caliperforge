import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../../providers/kind.ts'
import { authority } from '../../../rails/authority/index.ts'
import { packet, refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const SEAT = 'solidity_specialist'

test('the manifest declares seat, model, effort, tools and paths', () => {
  expect(Seat.parse(seat(root, SEAT).manifest)).toMatchObject({
    seat: SEAT,
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(forge:*)', 'Bash(cast:*)', 'Bash(python3:*)'],
    write_paths: ['sample', 'test', 'index'],
  })
})

test('the roster carries the seat', () => {
  expect(rules(root).find((r) => r.id === SEAT)).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the prompt carries Foundry, solc, transaction and RPC lines', () => {
  const { prompt } = seat(root, SEAT)
  for (const line of [
    'Foundry is on the host (`forge 1.7.1` as of 2026-09-27).',
    'Pin solc per project, never globally.',
    'Never deploy, never send a transaction, never use a private key.',
    'RPC reads go only through the endpoints the\nrepo names, written out in full in the command, because the gate refuses `$`.',
  ]) expect(prompt).toContain(line)
})

test('the prompt carries own-repo rules, density line and fence', () => {
  const { prompt } = seat(root, SEAT)
  for (const line of [
    'On our own repository:',
    '- A comment states, in one sentence, a fact the code cannot say.',
    '- Why a change was made goes in the commit message, never in a comment.',
    '- Code the change replaces is deleted in the same job.',
    '- A fallback records that it fell back.',
    '- New logic goes in a new file rather than growing a file past its budget.',
    "On anyone else's repository, match its comment density instead.",
    '- id: D1',
    "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
    'follow it under `# The files`',
  ]) expect(prompt).toContain(line)
})

test('write_paths admit sample, test and index, and nothing else', () => {
  const paths = seat(root, SEAT).manifest.write_paths
  expect(refuse(root, paths, 'sample/Hook.sol')).toBeNull()
  expect(refuse(root, paths, 'test/Invariant.t.sol')).toBeNull()
  expect(refuse(root, paths, 'index/hooks.json')).toBeNull()
  expect(refuse(root, paths, 'src/Hook.sol')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(refuse(root, paths, '../escape.sol')).toMatchObject({ origin_ref: 'seat.write_paths' })
  const hunk = `--- a/src/Hook.sol\n+++ b/src/Hook.sol\n@@ -1,1 +1,1 @@\n+x\n`
  expect(authority(root, SEAT, hunk))
    .toMatchObject({ outcome: 'refuse', spans: ['src/Hook.sol:1 authority.write_paths'] })
})

const ran = (p: Packet, command: string, background?: boolean) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: background === undefined ? { command } : { command, run_in_background: background } } as never)

test('only forge, cast and python3 run, in the foreground', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  for (const command of ['forge build', 'forge test', 'cast call', 'python3 sample/run.py']) {
    expect(ran(p, command)).toEqual({ continue: true })
  }
  for (const command of ['curl x', 'forge test && cast send x', 'npm install', 'cast call $RPC']) {
    expect(ran(p, command)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  }
  const denied = ran(p, 'forge test', true)
  expect(denied).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny' } })
  expect(denied.stopReason).toBeUndefined()
})
