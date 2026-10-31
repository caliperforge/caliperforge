import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import type { Packet, Provider } from '../../../providers/kind.ts'
import { real } from '../../../runner/index.ts'
import { seat } from '../../../runner/rules.ts'
import { staffed } from '../../../sequencer/staffing.ts'
import { mapOf } from '../../../sequencer/steps.ts'
import { git, maybe, put, srcDir } from '../../../sequencer/workspace.ts'
import { runRows } from '../../../store/events.ts'
import { pipeNamed, planById, putPlan } from '../../../store/plans.ts'
import { generated as generatedRuns } from '../../../store/runs.ts'
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

const READ = '- x-ray/x-ray.md, Vault.deposit and Vault.redeem — the entry points to call'
const STAND_INS = '\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call, only vault mints\n'
const FACTS = ['Signatures', 'Guards', 'Roles', 'Limits'].map((name) => `\n## ${name}\n\n- none\n`).join('')
const FILLED: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n\n## Reads\n\n${READ}\n${FACTS}`,
  scaffold: `phase: scaffold\nnext: coverage\n\n## Reads\n\n${READ}\n${FACTS}${STAND_INS}`,
  coverage: `phase: coverage\nnext: invariants\nfuzz_build_cmd: forge build\n\n## Reads\n\n${READ}\n${FACTS}`,
  invariants: `phase: invariants\nnext: campaigns\n\n## Reads\n\n${READ}\n${FACTS}\n## Converted values\n\n- property_redeemConserves | tolerance: 2 wei × 3\n`,
}
const PHASES = Object.keys(FILLED)
const SPAWN = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } })
const HANDOFFS = 'test/fizz/fizz_data/handoff'

const CLEAN = "## Share-Converted Comparisons\n\n```sh\ngrep -rn 'assertEq(.*convertToAssets' {SUITE_DIR}\n```\n\n## Unbounded Stand-ins\n\n```sh\ngrep -rln 'contract Mock' {SUITE_DIR}\n```\n"

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'cf-fizz-home-'))
  mkdirSync(join(home, '.claude/skills/fizz/references'), { recursive: true })
  writeFileSync(join(home, '.claude/skills/fizz/references/critic-pass.md'), CLEAN)
  vi.stubEnv('HOME', home)
})

afterEach(() => { vi.unstubAllEnvs() })

const phaseOf = (packet: Packet | undefined): string | undefined => /^# Fizz lean: (\w+)/m.exec(packet?.prompt ?? '')?.[1]

function stub(tokens: number, filled: Record<string, string>, spawns: Record<string, number>): { provider: Provider; packets: Packet[] } {
  const packets: Packet[] = []
  return { packets, provider: { name: 'claude-agent-sdk', fire: (packet) => {
    packets.push(packet)
    const phase = phaseOf(packet) ?? ''
    mkdirSync(join(packet.cwd, HANDOFFS), { recursive: true })
    writeFileSync(join(packet.cwd, HANDOFFS, `${phase}.md`), filled[phase] ?? '')
    writeFileSync(packet.transcript, `${SPAWN}\n`.repeat(spawns[phase] ?? 0))
    if (phase === 'invariants') writeFileSync(join(packet.cwd, 'test/fizz/Properties.sol'), 'contract P { function property_a() public {} }\n')
    return Promise.resolve({ text: '', transcript_path: packet.transcript, usage: { input: tokens - 1000, cache: 0, output: 1000 }, seconds: 1,
      ended: 'completed', exit: 0, stop_reason: null, denials: 0 })
  } } }
}

async function generated(generator: string, tokens = 1000, filled = FILLED, spawns: Record<string, number> = {}) {
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
  const fired = stub(tokens, filled, spawns)
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
  expect(packets).toHaveLength(4)
  expect(packets[0]?.prompt).toContain(`SKILL_PATH is ${skill}.`)
  expect(packets[0]?.reads?.[0]).toBe(skill)
  expect(packets[0]).toMatchObject({ idle: 60, wall: 6_000_000 })
  expect(runRows(db)[0]).toMatchObject({ seat: 'fizz_lean_generator', staffed: 'fizz_lean_generator' })
})

test('D4: fizz still reads its skill from home with idle 60', async () => {
  const { packets } = await generated('fizz')
  expect(packets[0]?.prompt).toContain(`SKILL_PATH is ${real(join(homedir(), '.claude/skills/fizz'))}.`)
  expect(packets[0]?.idle).toBe(60)
})

test('D5: a fizz_lean run at the ceiling is refused', async () => {
  const { tree, outcome, packets } = await generated('fizz_lean', CEILING)
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['bench.ceiling'] })
  expect(packets).toHaveLength(1)
  expect(maybe(tree, 1, 'generate.json')).toBeNull()
})

test('D1 D5: lean fires each phase but campaigns, one run each', async () => {
  const { tree, db, outcome, packets } = await generated('fizz_lean')
  expect(outcome).toMatchObject({ outcome: 'pass' })
  expect(packets.map(phaseOf)).toEqual(['context', 'scaffold', 'coverage', 'invariants'])
  PHASES.forEach((phase, at) => { expect(packets[at]?.prompt).toContain(readFileSync(join(tree, `seats/fizz_lean_generator/skill/phases/${phase}.md`), 'utf8')) })
  const paths = runRows(db).map((row) => row.transcript_path)
  expect(paths).toHaveLength(4)
  expect(new Set(paths).size).toBe(4)
  for (const path of paths) expect(path).toMatch(/run-\d+\.transcript\.jsonl$/)
  expect(readFileSync(join(packets[3]?.cwd ?? '', HANDOFFS, 'critic.md'), 'utf8')).toBe('')
})

test('D8: a plain fizz run fires once and writes no critic.md', async () => {
  const { packets } = await generated('fizz')
  expect(packets).toHaveLength(1)
  expect(existsSync(join(packets[0]?.cwd ?? '', HANDOFFS, 'critic.md'))).toBe(false)
})

test('D1: each lean run records its phase, fizz records none', async () => {
  expect(generatedRuns((await generated('fizz_lean')).db, 1).map((r) => r.phase)).toEqual(PHASES)
  expect(generatedRuns((await generated('fizz')).db, 1).map((r) => r.phase)).toEqual([null])
})

test('D2: the scaffold issue names the context handoff', async () => {
  const { packets } = await generated('fizz_lean')
  expect(packets[1]?.prompt).toContain(`Start from ${join(packets[1]?.cwd ?? '', HANDOFFS, 'context.md')}.`)
})

test('D3: a refused handoff re-fires once, then is refused', async () => {
  const { outcome, packets } = await generated('fizz_lean', 1000, { ...FILLED, scaffold: (FILLED.scaffold ?? '').replace(STAND_INS, '') })
  expect(packets.map(phaseOf)).toEqual(['context', 'scaffold', 'scaffold'])
  expect(packets[2]?.prompt).toContain('Your handoff was refused:\n- handoff.field: scaffold: ## Stand-ins is missing or has no row')
  expect(outcome).toMatchObject({ outcome: 'refuse', spans: ['handoff.field'], note: expect.stringContaining('scaffold handoff refused twice') as string })
})

test('D4: no lean packet carries the conductor prompt', async () => {
  const { tree, packets } = await generated('fizz_lean')
  const conductor = readFileSync(join(tree, 'seats/fizz_lean_generator/prompt.md'), 'utf8').trim()
  for (const packet of packets) expect(packet.prompt).not.toContain(conductor)
})

test('D4: every lean packet is ranged, a fizz packet is not', async () => {
  for (const packet of (await generated('fizz_lean')).packets) expect(packet.ranged).toBe(true)
  expect((await generated('fizz')).packets[0]?.ranged).not.toBe(true)
})

test('D6: generate.json agents adds up every phase transcript', async () => {
  const { tree } = await generated('fizz_lean', 1000, FILLED, { context: 1, scaffold: 2 })
  expect(JSON.parse(maybe(tree, 1, 'generate.json') ?? '{}')).toMatchObject({ agents: 3, tokens: 4000, seconds: 4, properties: 1 })
})

test('D6: a drifted fizz_lean_generator prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/fizz_lean_generator/prompt.md'), '\n')
  expect(() => seat(tree, 'fizz_lean_generator')).toThrow(/prompt does not match its digest/)
})
