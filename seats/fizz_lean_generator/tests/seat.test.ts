import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Packet, Provider } from '../../../providers/kind.ts'
import { real } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'
import { staffed } from '../../../sequencer/staffing.ts'
import { mapOf } from '../../../sequencer/steps.ts'
import { git, maybe, put, srcDir } from '../../../sequencer/workspace.ts'
import { runRows } from '../../../store/events.ts'
import { pipeNamed, planById, putPlan } from '../../../store/plans.ts'
import { CEILING, generate } from '../../../templates/bench.ts'

const root = join(import.meta.dirname, '../../..')
const schema = join(root, 'schema')
const AT = '2026-10-28T13:00:00.000Z'
const TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent', 'Bash(pwd)', 'Bash(forge:*)', 'Bash(FOUNDRY_PROFILE=fuzz forge:*)', 'Bash(medusa:*)',
  'Bash(echidna:*)', 'Bash(node:*)', 'Bash(bash:*)', 'Bash(rm -f /tmp/x-ray-attempts.md)', 'Bash(mkdir -p x-ray)', 'Bash(python3:*)']

function copied(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-fizz-lean-generator-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  return tree
}

function stub(tokens: number): { provider: Provider; packets: Packet[] } {
  const packets: Packet[] = []
  return { packets, provider: { name: 'claude-agent-sdk', fire: (packet) => {
    packets.push(packet)
    return Promise.resolve({ text: '', transcript_path: packet.transcript, usage: { input: tokens - 1000, cache: 0, output: 1000 }, seconds: 1,
      ended: 'completed', exit: 0, stop_reason: null, denials: 0 })
  } } }
}

async function generated(generator: string, tokens = 1000) {
  const tree = copied()
  const dir = srcDir(tree, 1)
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'Vault.sol'), 'contract Vault {}\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'vault'])
  put(tree, 1, 'checkout.json', JSON.stringify({ pre_fix: git(dir, ['rev-parse', 'HEAD']).trim() }))
  put(tree, 1, 'target.yml', `generator: ${generator}`)
  const db = fresh(schema)
  putPlan(db, { id: 1, pipe_id: Number(pipeNamed(db, 'bench')?.id), target_id: null, template: 'bench', state: 'queued', queued_at: AT, step: 1, retries: 0 })
  const fired = stub(tokens)
  const outcome = await generate(db, tree, planById(db, 1), mapOf('bench').at(1), fired.provider)
  return { tree, db, outcome, packets: fired.packets }
}

test('D1: the manifest loads past its digests', () => {
  expect(seat(root, 'fizz_lean_generator').manifest).toEqual({
    seat: 'fizz_lean_generator', model: 'claude-opus-5-5', effort: 'high', tools: TOOLS,
    reads: ['seats/fizz_lean_generator/skill', '~/.claude/skills/fizz', '~/.claude/skills/x-ray'],
    write_paths: ['test/fizz', 'x-ray', 'medusa.json', 'PROPERTIES.md', 'echidna.yaml', 'foundry.toml'],
  })
})

test('D2: fizz_lean staffs the lean seat and fizz stays fizz', () => {
  expect(staffed(root, 'bench', 1, 'fizz_lean')).toEqual({ seat: 'fizz_lean_generator' })
  expect(staffed(root, 'bench', 1, 'fizz')).toEqual({ seat: 'fizz_generator' })
})

test('D3: fizz_lean reads its skill from the tree it runs in', async () => {
  const { tree, db, packets } = await generated('fizz_lean')
  const skill = real(join(tree, 'seats/fizz_lean_generator/skill'))
  expect(packets).toHaveLength(1)
  expect(packets[0]?.prompt).toContain(`SKILL_PATH is ${skill}.`)
  expect(packets[0]?.reads?.[0]).toBe(skill)
  expect(packets[0]).toMatchObject({ idle: 60, wall: 6_000_000 })
  expect(runRows(db)).toMatchObject([{ seat: 'fizz_lean_generator', staffed: 'fizz_lean_generator' }])
})

test('D4: fizz still reads its skill from home with idle 60', async () => {
  const { packets } = await generated('fizz')
  expect(packets[0]?.prompt).toContain(`SKILL_PATH is ${real(join(homedir(), '.claude/skills/fizz'))}.`)
  expect(packets[0]?.idle).toBe(60)
})

test('D5: a fizz_lean run at the ceiling is refused', async () => {
  const { tree, outcome } = await generated('fizz_lean', CEILING)
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.ceiling'] })
  expect(maybe(tree, 1, 'generate.json')).toBeNull()
})

test('D6: a drifted fizz_lean_generator prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/fizz_lean_generator/prompt.md'), '\n')
  expect(() => seat(tree, 'fizz_lean_generator')).toThrow(/prompt does not match its digest/)
})
