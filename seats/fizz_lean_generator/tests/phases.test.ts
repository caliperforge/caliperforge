import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { critic } from '../../../templates/critic.ts'
import { type Fire, phased } from '../../../templates/phases.ts'

const root = join(import.meta.dirname, '../../..')
const skill = join(root, 'seats/fizz_lean_generator/skill')
const fizz = readFileSync(join(root, 'seats/fizz_generator/prompt.md'), 'utf8')
const STEP_5 = '## Step 5: Generate Scaffold'
const STEP_8 = '## Step 8: Reach Coverage With Medusa'
const PHASES: [string, string, string | null][] = [
  ['context', '## Step 0: Print Banner', STEP_5],
  ['scaffold', STEP_5, STEP_8],
  ['coverage', STEP_8, '## Step 9: Generate Invariants'],
  ['invariants', '## Step 9: Generate Invariants', '## Step 10: Run Campaigns'],
  ['campaigns', '## Step 10: Run Campaigns', null],
]
const READ = '- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.'
const CLAMPED = '- In Step 7, for each state-changing entry point a property or a Step 3 candidate invariant targets, write a <contract>_<function>_clamped handler beside the raw one that bounds each argument to values the call accepts.'
const FILL = '- Fill your handoff\'s fact sections (## Signatures, ## Guards, ## Roles, ## Limits) with what the next phase needs, each row naming the file and line range you read it at, or - none when there is nothing to carry.'
const FROM = '- Work from that handoff\'s fact sections before opening code: open a source file only at a line range they name, or for a fact they do not hold.'
const SUB = '- Give each sub-agent you spawn the path of the handoff named by Start from and, in place of whole source files, only the ## Signatures line ranges of the contracts it works on.'
const CRITIC = '- Before you write the handoff, run both checks in {SKILL_PATH}/references/critic-pass.md and clear every hit the way that file says.'
const READS = ', with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`'
const written = (name: string): string =>
  `- Before you end, write {META_DIR}/handoff/${name}.md, the path the issue names, from its \`# Handoff: ${name}\` block${name === 'campaigns' ? '' : READS}.`

function at(heading: string): number {
  const i = fizz.indexOf(`\n${heading}`)
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

const range = (start: string, end: string | null): string => fizz.slice(at(start), end === null ? undefined : at(end))
const phase = (name: string): string => readFileSync(join(skill, 'phases', `${name}.md`), 'utf8')
const steps = (text: string): string[] => text.match(/^#{2,3} Step .*$/gm) ?? []

function verbatim(file: string, block: string): void {
  expect(file.split(block)).toHaveLength(2)
}

function own(file: string, block: string): void {
  expect(steps(file)).toEqual(steps(block))
}

function handover(name: string, file: string, block: string): void {
  const [head, tail] = file.split(block)
  expect(tail).toBe('')
  expect(head).toMatch(new RegExp(`^# Fizz lean: ${name} \\(Steps [\\d.]+-[\\d.]+\\)\\n\\n## Handover\\n(?:(?!#).*\\n)*$`))
  for (const named of ['{META_DIR}/context.md', '{META_DIR}/reports/', '300 words', '~/.claude/skills/fizz']) expect(head).toContain(named)
  expect(head).toContain(written(name))
  if (name !== 'context') expect(head).toContain(READ)
  if (name === 'scaffold') expect(head).toContain(CLAMPED)
  if (name !== 'campaigns') expect(head).toContain(FILL)
  expect(head?.includes(FROM)).toBe(!['context', 'campaigns'].includes(name))
  expect(head?.includes(SUB)).toBe(name === 'invariants')
  expect(head?.includes(CRITIC)).toBe(name === 'invariants')
  expect(head).not.toMatch(/\bread\b[^\n]*\{META_DIR\}\/reports\//)
}

test.each(PHASES)('D1-D3: %s.md is a handover then its steps verbatim', (name, start, end) => {
  const [file, block] = [phase(name), range(start, end)]
  verbatim(file, block)
  own(file, block)
  handover(name, file, block)
})

test('D4: an edited Step 6 or an appended Step 8 fails', () => {
  const [file, block] = [phase('scaffold'), range(STEP_5, STEP_8)]
  const edited = file.replace('Modify the scaffolded core files', 'Edit the scaffolded core files')
  expect(edited).not.toBe(file)
  expect(() => { verbatim(edited, block) }).toThrow()
  expect(() => { own(`${file}${STEP_8}\n`, block) }).toThrow()
})

test('D2-D3: a reports read or a dropped clamped line fails', () => {
  const [file, block] = [phase('scaffold'), range(STEP_5, STEP_8)]
  const reports = `${READ}\n- Before the first step, read every report under {PROJECT_ROOT}/{META_DIR}/reports/.`
  expect(() => { handover('scaffold', file.replace(READ, reports), block) }).toThrow()
  expect(() => { handover('scaffold', file.replace(`${CLAMPED}\n`, ''), block) }).toThrow()
})

test.each([{ name: 'SUB', line: SUB }, { name: 'FILL', line: FILL }, { name: 'FROM', line: FROM }, { name: 'CRITIC', line: CRITIC }])('D5: invariants without $name fails', ({ line }) => {
  const [file, block] = [phase('invariants'), range('## Step 9: Generate Invariants', '## Step 10: Run Campaigns')]
  expect(() => { handover('invariants', file.replace(`${line}\n`, ''), block) }).toThrow()
})

test('D5: the lean skill holds no copied fizz folders', () => {
  for (const dir of ['references', 'agents', 'scripts', 'templates']) expect(existsSync(join(skill, dir))).toBe(false)
})

const FACTS = ['Signatures', 'Guards', 'Roles', 'Limits'].map((name) => `\n## ${name}\n\n- none\n`).join('')
const HANDED = `\n## Reads\n\n- x-ray/x-ray.md, Vault.deposit — the entry point to call\n${FACTS}`
const FILLED: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n${HANDED}`,
  scaffold: `phase: scaffold\nnext: coverage\n${HANDED}\n## Stand-ins\n\n- MockStrategy | limits: max interest 1e15 per call\n`,
  coverage: `phase: coverage\nnext: invariants\nfuzz_build_cmd: forge build\n${HANDED}`,
  invariants: `phase: invariants\nnext: campaigns\n${HANDED}\n## Converted values\n\n- property_redeemConserves | tolerance: 2 wei\n`,
}
const CHECKS: [string, string][] = [['Share-Converted Comparisons', "grep -rn 'assertEq(.*convertToAssets' {SUITE_DIR}"],
  ['Unbounded Stand-ins', 'for f in $(grep -rl \'contract Mock\' {SUITE_DIR}); do grep -q \'// stand-in limits:\' "$f" || echo "$f"; done']]
const pass = (dropped = ''): string => CHECKS.map(([heading, sh]) => `## ${heading}\n\n${heading === dropped ? '' : `\`\`\`sh\n${sh}\n\`\`\`\n`}`).join('\n')
const CONVERTED = 'assertEq(vault.convertToAssets(s), a);\n'
const MOCK = 'contract MockOracle {}\n'
const CLEAN = { 'Suite.sol': 'assertApproxEqAbs(vault.convertToAssets(s), a, 2);\n', 'Mock.sol': 'contract MockOracle {} // stand-in limits: 1e6 of start\n' }

async function ran(suite: Record<string, string>, filled = FILLED) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fizz-critic-'))
  const handoffs = join(dir, 'test/fizz/fizz_data/handoff')
  mkdirSync(handoffs, { recursive: true })
  for (const [name, text] of Object.entries(suite)) writeFileSync(join(dir, 'test/fizz', name), text)
  writeFileSync(join(dir, 'critic-pass.md'), pass())
  const fires: { phase: string; issue: string }[] = []
  const critics = vi.fn(() => critic(join(dir, 'critic-pass.md'), dir))
  const fire: Fire = (...args) => {
    const [, issue, sum, phase = ''] = args
    fires.push({ phase, issue })
    writeFileSync(join(handoffs, `${phase}.md`), filled[phase] ?? '')
    return Promise.resolve({ ...sum, tokens: sum.tokens + 1 })
  }
  const sum = await phased(fire, skill, handoffs, 'Generate.', critics)
  const invariants = fires.filter((f) => f.phase === 'invariants')
  return { sum, invariants, critics, critic: join(handoffs, 'critic.md') }
}

test('D1: an untolerated convertToAssets assertEq is sent back', async () => {
  const { invariants } = await ran({ 'Suite.sol': CONVERTED })
  expect(invariants[1]?.issue).toContain('Your handoff was refused:\n- critic.share_converted: test/fizz/Suite.sol:1:assertEq(')
})

test('D2: a MockOracle with no stand-in limits is sent back', async () => {
  const { invariants } = await ran({ 'Mock.sol': MOCK })
  expect(invariants[1]?.issue).toContain('Your handoff was refused:\n- critic.stand_in: test/fizz/Mock.sol')
})

test('D3: a clean suite fires invariants once, empty critic.md', async () => {
  const { invariants, critic: path } = await ran(CLEAN)
  expect(invariants).toHaveLength(1)
  expect(readFileSync(path, 'utf8')).toBe('')
})

test('D4: hits left on the retry land in critic.md, run goes on', async () => {
  const { sum, invariants, critic: path } = await ran({ 'Suite.sol': CONVERTED, 'Mock.sol': MOCK })
  expect(sum).toMatchObject({ tokens: 5, wall: null })
  expect(invariants).toHaveLength(2)
  expect(readFileSync(path, 'utf8')).toBe(`critic.share_converted: test/fizz/Suite.sol:1:${CONVERTED}critic.stand_in: test/fizz/Mock.sol\n`)
})

test('D5: a twice-refused invariants handoff skips the critic', async () => {
  const { sum, critics, critic: path } = await ran({ 'Mock.sol': MOCK }, { ...FILLED, invariants: '' })
  expect(sum).toMatchObject({ outcome: 'refuse', note: expect.stringContaining('invariants handoff refused twice') as string })
  expect(critics).not.toHaveBeenCalled()
  expect(existsSync(path)).toBe(false)
})

test.each(CHECKS.map(([heading]) => heading))('D6: a critic pass with no sh block under %s throws', (heading) => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fizz-critic-'))
  writeFileSync(join(dir, 'critic-pass.md'), pass(heading))
  expect(() => critic(join(dir, 'critic-pass.md'), dir)).toThrow(`${join(dir, 'critic-pass.md')} has no sh block under ${heading}`)
})
