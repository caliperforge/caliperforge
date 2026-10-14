import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { gate } from '../../../providers/claude-agent-sdk/index.ts'
import type { Packet } from '../../../providers/kind.ts'
import { authority } from '../../../rails/authority/index.ts'
import { packet, refuse } from '../../../runner/index.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'
import { fenceFor } from '../../../sequencer/route.ts'
import { putPlan } from '../../../store/plans.ts'

const root = join(import.meta.dirname, '../../..')
const SEAT = 'solidity_specialist'

test('the manifest declares seat, model, effort, tools and paths', () => {
  expect(Seat.parse(seat(root, SEAT).manifest)).toMatchObject({
    seat: SEAT,
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: [
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(forge:*)', 'Bash(cast:*)', 'Bash(python3:*)',
      'Bash(medusa:*)', 'Bash(echidna:*)', 'Bash(slither:*)', 'Bash(slither-mutate:*)',
    ],
    write_paths: ['sample', 'test', 'index', ...['src', 'bench', 'smoke', 'targets', 'tests', 'suites'].map((p) => `caliperforge/fuzz-bench:${p}`)],
  })
})

test('the roster carries the seat', () => {
  expect(rules(root).find((r) => r.id === SEAT)).toMatchObject({ kind: 'card', path: `rules/roster/${SEAT}.yaml` })
})

test('the prompt carries Foundry, solc, transaction and RPC lines', () => {
  const { prompt } = seat(root, SEAT)
  for (const line of [
    'Foundry is on the host (`forge 1.7.1` as of 2026-09-27).',
    'Pin solc per project, never globally.',
    '`sample/`, `test/` and `index/` are the only trees you may\nwrite in, and on caliperforge/fuzz-bench also `src/`, `bench/`, `smoke/`, `targets/`, `tests/` and `suites/`; a write outside them is refused',
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

const OWN = ['bench/x.py', 'src/oracles/X.sol']
const hunks = (paths: string[]) => paths.map((p) => `--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n+x\n`).join('')

function fenceOn(repo: string): string[] {
  const db = fresh(join(root, 'schema'))
  putPlan(db, { id: 1, pipe_id: 1, lane: 'uniswap', seat: SEAT, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-10-13', step: 0, retries: 0,
    origin: `https://github.com/caliperforge/${repo}/issues/1` })
  return fenceFor(db, 1, seat(root, SEAT).manifest.write_paths)
}

test('1157d D1 fuzz-bench admits bench, src and test', () => {
  const fence = fenceOn('fuzz-bench')
  for (const path of [...OWN, 'test/X.t.sol']) expect(refuse(root, fence, path)).toBeNull()
  for (const path of ['lib/X.sol', '../escape.sol']) expect(refuse(root, fence, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(authority(root, SEAT, hunks(OWN), false, fence)).toMatchObject({ outcome: 'pass' })
})

test('1157d D2 v4-hook-index keeps sample, test and index only', () => {
  const fence = fenceOn('v4-hook-index')
  for (const path of ['sample/Hook.sol', 'test/Invariant.t.sol', 'index/hooks.json']) expect(refuse(root, fence, path)).toBeNull()
  for (const path of [...OWN, '../escape.sol']) expect(refuse(root, fence, path)).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(authority(root, SEAT, hunks(OWN), false, fence)).toMatchObject({ outcome: 'refuse',
    spans: ['bench/x.py:1 authority.write_paths', 'src/oracles/X.sol:1 authority.write_paths'] })
})

const ran = (p: Packet, command: string, background?: boolean) =>
  gate(p, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: background === undefined ? { command } : { command, run_in_background: background } } as never)

test('forge cast python3 medusa echidna slither slither-mutate run', () => {
  const { manifest, prompt } = seat(root, SEAT)
  const p = packet(manifest, prompt, '', '', root, join(root, 'x.transcript.jsonl'))
  for (const command of [
    'forge build', 'forge test', 'cast call', 'python3 sample/run.py',
    'medusa fuzz', 'echidna test/Invariant.t.sol', 'slither .', 'slither-mutate .',
  ]) {
    expect(ran(p, command)).toEqual({ continue: true })
  }
  for (const command of ['curl x', 'forge test && cast send x', 'npm install', 'cast call $RPC', 'slither . && curl x']) {
    expect(ran(p, command)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  }
  for (const command of ['forge test', 'medusa fuzz']) {
    const denied = ran(p, command, true)
    expect(denied).toMatchObject({ continue: true, hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(denied.stopReason).toBeUndefined()
  }
})
