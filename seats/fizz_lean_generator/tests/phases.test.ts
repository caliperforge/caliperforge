import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Miss, Packet } from '../../../providers/kind.ts'
import { get } from '../../../sequencer/workspace.ts'
import { eventsAfter } from '../../../store/events.ts'
import { critic } from '../../../templates/critic.ts'
import { type Item, reach } from '../../../templates/reach.ts'
import { report } from '../../../templates/report.ts'
import { packed, smoke, type Smoked } from '../../../templates/smoke.ts'
import { suite, type Suite } from '../../../templates/suite.ts'
import { benched, transcripts } from './benched.ts'

const EMPTY = vi.hoisted((): Suite => ({ deployed: [], actors: [], handlers: [], standIns: [], probes: [], trackers: [], build: { command: null, via_ir: null, optimizer: null } }))

vi.mock('../../../templates/suite.ts', async (importOriginal) => ({ ...await importOriginal<object>(), suite: vi.fn(() => EMPTY) }))

vi.mock('../../../templates/smoke.ts', async (importOriginal) => ({ ...await importOriginal<object>(), smoke: vi.fn(() => []) }))

vi.mock('../../../templates/reach.ts', async (importOriginal) => ({ ...await importOriginal<object>(), reach: vi.fn(() => []) }))

vi.mock('../../../templates/probes.ts', async (importOriginal) => ({ ...await importOriginal<object>(), trackers: vi.fn(() => new Map()) }))

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
  if (!['context', 'campaigns'].includes(name)) expect(head).toContain(FILL)
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
const TRACKED = ['Conversion points', 'Aggregates', 'Not tracked'].map((name) => `\n## ${name}\n\n- none\n`).join('')
const HANDED = `\n## Reads\n\n- x-ray/x-ray.md, Vault.deposit — the entry point to call\n${FACTS}`
const FILLED: Record<string, string> = {
  context: `phase: context\nnext: scaffold\nmode: automatic\nagent_model: opus\n${HANDED}${TRACKED}`,
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
  const { run } = benched((packet, phase) => {
    fires.push({ phase, issue: packet.prompt })
    writeFileSync(join(handoffs, `${phase}.md`), filled[phase] ?? '')
    return {}
  })
  const sum = await run(skill, handoffs, critics)
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

function legs(stop?: string, mapped = false) {
  const handoffs = join(mkdtempSync(join(tmpdir(), 'cf-fizz-stop-')), 'test/fizz/fizz_data/handoff')
  mkdirSync(handoffs, { recursive: true })
  const fires: { phase: string; issue: string }[] = []
  const { run } = benched((packet, phase) => {
    fires.push({ phase, issue: packet.prompt })
    writeFileSync(join(handoffs, `${phase}.md`), FILLED[phase] ?? '')
    if (mapped) writeFileSync(join(handoffs, 'map.md'), `## Guards\n\n- V.deposit | reverts: ${phase}\n`)
    return { usage: { input: 0, cache: 0, output: 10 }, seconds: 2 }
  })
  return { handoffs, fires, run: () => run(skill, handoffs, () => [], stop) }
}

test('stop D1: stop after context fires context alone and holds', async () => {
  const { handoffs, fires, run } = legs('context')
  expect(await run()).toEqual({ outcome: 'pass', held: true, spans: ['bench.stop_after'], note: 'stopped after context for a look' })
  expect(fires.map((f) => f.phase)).toEqual(['context'])
  expect(existsSync(join(handoffs, 'context.md'))).toBe(true)
  expect(existsSync(join(handoffs, 'stopped.json'))).toBe(true)
})

test('stop D2 D3: a resumed run starts at scaffold, sums both legs', async () => {
  const { handoffs, fires, run } = legs('context')
  await run()
  const resumed = await run()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants'])
  expect(fires[1]?.issue).toContain(`Start from ${join(handoffs, 'context.md')}.`)
  expect(existsSync(join(handoffs, 'stopped.json'))).toBe(false)
  expect(resumed).toEqual(await legs().run())
  expect(resumed).toMatchObject({ tokens: 40, seconds: 8, transcripts: transcripts(4) })
})

const AT = [{ file: 'src/V.sol', start: 9, end: 9 }]
const MISSES: Miss[] = [{ kind: 'read.map_miss', file: 'src/V.sol', lines: 'L1-end' }, { kind: 'read.slice_miss', file: 'src/V.sol', lines: 'L12-L30' }]

async function mapped(map = '## Guards\n\n- V.deposit | reverts: cap | at: src/V.sol L9-L9\n', appended: Record<string, string> = {}) {
  const handoffs = join(mkdtempSync(join(tmpdir(), 'cf-fizz-mapped-')), 'test/fizz/fizz_data/handoff')
  mkdirSync(join(handoffs, 'excerpts'), { recursive: true })
  writeFileSync(join(handoffs, 'map.md'), map)
  const fizz = join(mkdtempSync(join(tmpdir(), 'cf-fizz-skill-')), 'fizz')
  mkdirSync(join(fizz, 'references'), { recursive: true })
  writeFileSync(join(fizz, 'references/critic-pass.md'), pass())
  const packets: Packet[] = []
  const fires: { phase: string; issue: string; map: string }[] = []
  const { db, root, run } = benched((packet, phase) => {
    packets.push(packet)
    fires.push({ phase, issue: packet.prompt, map: readFileSync(join(handoffs, 'map.md'), 'utf8') })
    appendFileSync(join(handoffs, 'map.md'), appended[phase] ?? '')
    writeFileSync(join(handoffs, `${phase}.md`), FILLED[phase] ?? '')
    return phase === 'scaffold' ? { misses: MISSES } : {}
  }, [fizz])
  return { db, root, handoffs, packets, fires, sum: await run(skill, handoffs, () => []) }
}

test('D2: context is ranged, later phases carry map.md ranges', async () => {
  const { packets, sum } = await mapped()
  expect(sum).toMatchObject({ tokens: 4, wall: null })
  expect(packets.map((p) => [p.ranged, p.map])).toEqual([[true, undefined], ...Array<unknown>(3).fill([undefined, { ranges: AT, slice: AT }])])
})

test('D3 D4: two scaffold misses log as events report() counts', async () => {
  const { db, root } = await mapped()
  const event = { plan: 1, actor: 'fizz_lean_generator', outcome: 'pass', pointer: null, run: 2 }
  expect(eventsAfter(db, 0).filter((e) => e.kind.startsWith('read.'))).toEqual([
    { ...event, kind: 'read.map_miss', message: '{"file":"src/V.sol","line":1}' },
    { ...event, kind: 'read.slice_miss', message: '{"file":"src/V.sol","line":12}' },
  ])
  report(db, root, 1, [], null)
  expect(JSON.parse(get(root, 1, 'report.json'))).toMatchObject({ map: { map_miss: 1, slice_miss: 1 } })
})

const RAW: Suite['handlers'][number] = { file: 'test/fizz/H.sol', start: 1, end: 1, name: 'V_deposit', clamped: false, target: 'V.deposit', clamps: [] }
const SMOKED: Smoked[] = [{ name: 'V.deposit(uint256 assets)', calls: 10, successes: 4 }]

test('D2-D4: a suite refusal fires a fix turn before coverage', async () => {
  vi.mocked(suite).mockReturnValueOnce(EMPTY).mockReturnValueOnce({ ...EMPTY, handlers: [RAW] })
  vi.mocked(smoke).mockReturnValueOnce(SMOKED)
  const { db, handoffs, fires } = await mapped('## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n')
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold-fix-suite-1', 'coverage', 'invariants'])
  expect(fires[2]?.issue).toContain('scaffold: V.deposit has no raw handler')
  expect(fires[3]?.issue).toContain(packed(SMOKED))
  expect(readFileSync(join(handoffs, 'map.md'), 'utf8')).toContain('## Handlers\n\n- V_deposit | target: V.deposit | clamps: none | at: test/fizz/H.sol L1-L1\n')
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'fix.turn')).toEqual([
    { plan: 1, kind: 'fix.turn', actor: 'fizz_lean_generator', outcome: 'pass', message: '{"turn":1,"tokens":1,"usd":0}', pointer: null, run: null },
  ])
})

const UNMET: Item = { key: 'Guards V.deposit', met: false, cells: ['passing: no', 'reverting: yes'], note: 'Guards V.deposit: passing never seen', reverts: [] }
const UNREACHABLE = (reason: string): string => `\n## Unreachable\n\n- Guards V.deposit | reason: ${reason}\n`
const LEAN = ['context', 'scaffold', 'coverage']

test('reach D1 D2: an unmet item fires one fix before invariants', async () => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { handoffs, fires } = await mapped(undefined, { 'coverage-fix-reach-1': UNREACHABLE('only the bridge calls it') })
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'coverage-fix-reach-1', 'invariants'])
  expect(fires[3]?.issue).toContain(`reach found:\n- ${UNMET.note}`)
  expect(fires[4]?.map).toContain('## Reach\n\n- Guards V.deposit | met: no | passing: no | reverting: yes\n')
  expect(fires[4]?.issue).toContain(`Read ${join(handoffs, 'map.md')} and the excerpts`)
})

test.each([{ name: 'nothing', text: '' }, { name: 'a placeholder', text: UNREACHABLE('<why no input reaches it>') }])('reach D3: a fix writing $name refuses', async ({ text }) => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { db, fires } = await mapped(undefined, { 'coverage-fix-reach-1': text })
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'coverage-fix-reach-1', 'coverage-fix-reach-2', 'invariants'])
  expect(eventsAfter(db, 0).filter((e) => ['reach.boundary', 'critic'].includes(e.kind)).map((e) => [e.kind, e.outcome, e.message])).toEqual([
    ['critic', 'refuse', 'not_clean: reach'], ['reach.boundary', 'refuse', JSON.stringify({ met: false, reasons: [UNMET.note] })],
  ])
})

test('reach D4: all met logs one pass and fires no fix', async () => {
  vi.mocked(reach).mockReturnValueOnce([{ ...UNMET, met: true, note: '' }])
  const { db, handoffs, fires } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'invariants'])
  expect(vi.mocked(reach).mock.lastCall?.slice(2, 4)).toEqual(['coverage/lcov.info', 'coverage/revert_report.json'].map((f) => join(handoffs, '../corpus_medusa', f)))
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'reach.boundary').map((e) => [e.outcome, e.message])).toEqual([['pass', '{"met":true,"reasons":[]}']])
})

test('reach D5: coverage.md and the # Map block carry reach', () => {
  expect(phase('coverage')).toContain('- The machine checks map.md after you end: it writes ## Reach, one row per selected entry point, guard, limit and conversion point with met: yes or no; read it in {META_DIR}/handoff/map.md and never edit it.\n'
    + '- The machine checks each met: no row of ## Reach: make it reachable, or write a map.md ## Unreachable row <that row\'s first cell> | reason: <why no input reaches it>.\n')
  expect(readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8')).toContain('## Unclamped\n\n- <Contract.function> | reason: <why it has no clamped handler>\n\n'
    + '## Unreachable\n\n- <the ## Reach row\'s first cell> | reason: <why no input reaches it>\n\n# Candidates')
})

test('no src: a map.md the agent writes checks no layer', async () => {
  const { fires, run } = legs(undefined, true)
  expect(await run()).toMatchObject({ tokens: 40, wall: null })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants'])
})

test('stop D6: no stop fires all four, writes no stopped.json', async () => {
  const { handoffs, fires, run } = legs()
  expect(await run()).toMatchObject({ tokens: 40, wall: null })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants'])
  expect(existsSync(join(handoffs, 'stopped.json'))).toBe(false)
})

test.each(CHECKS.map(([heading]) => heading))('D6: a critic pass with no sh block under %s throws', (heading) => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fizz-critic-'))
  writeFileSync(join(dir, 'critic-pass.md'), pass(heading))
  expect(() => critic(join(dir, 'critic-pass.md'), dir)).toThrow(`${join(dir, 'critic-pass.md')} has no sh block under ${heading}`)
})
