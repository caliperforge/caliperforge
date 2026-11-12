import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { admitted, type Fired, type Miss, type Packet } from '../../../providers/kind.ts'
import { get, planDir, put } from '../../../sequencer/workspace.ts'
import { scores, underpowered } from '../../../store/bench.ts'
import { eventsAfter } from '../../../store/events.ts'
import type { Db } from '../../../store/index.ts'
import { generated } from '../../../store/runs.ts'
import { critic, criticCheck } from '../../../templates/critic.ts'
import { compiled } from '../../../templates/extract.ts'
import type { fixed } from '../../../templates/graded.ts'
import { packets } from '../../../templates/plan.ts'
import { type Item, reach } from '../../../templates/reach.ts'
import { report } from '../../../templates/report.ts'
import { packed, primed, smoke, type Smoked } from '../../../templates/smoke.ts'
import { misaimed, suite, type Suite } from '../../../templates/suite.ts'
import { benched, transcripts } from './benched.ts'

const EMPTY = vi.hoisted((): Suite => ({ deployed: [], actors: [], handlers: [], standIns: [], probes: [], trackers: [], build: { command: null, via_ir: null, optimizer: null } }))

vi.mock('../../../templates/suite.ts', async (importOriginal) => ({ ...await importOriginal<object>(), suite: vi.fn(() => EMPTY), misaimed: vi.fn(() => []) }))

vi.mock('../../../templates/smoke.ts', async (importOriginal) => ({ ...await importOriginal<object>(), smoke: vi.fn(() => ({ results: [], note: null, cache: null, clamped: [] })), primed: vi.fn(() => ({ off: null, clamped: [] })) }))

vi.mock('../../../templates/reach.ts', async (importOriginal) => ({ ...await importOriginal<object>(), reach: vi.fn(() => []) }))

vi.mock('../../../templates/probes.ts', async (importOriginal) => ({ ...await importOriginal<object>(), trackers: vi.fn(() => new Map()) }))

vi.mock('../../../templates/extract.ts', async (importOriginal) => ({ ...await importOriginal<object>(), compiled: vi.fn(() => []) }))

vi.mock('../../../templates/critic.ts', async (importOriginal) => {
  const original = await importOriginal<{ criticCheck: typeof criticCheck }>()
  return { ...original, criticCheck: vi.fn(original.criticCheck) }
})

const FIXED = vi.hoisted(() => vi.fn<typeof fixed>())

vi.mock('../../../templates/graded.ts', async (importOriginal) => {
  const original = await importOriginal<{ fixed: typeof fixed }>()
  return { ...original, fixed: FIXED.mockImplementation(original.fixed) }
})

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

const suites = new Set<string>()

afterEach(() => {
  for (const dir of suites) rmSync(dir, { recursive: true, force: true })
  suites.clear()
})

function fizzed(): string {
  const fizz = join(mkdtempSync(join(tmpdir(), 'cf-fizz-skill-')), 'fizz')
  mkdirSync(join(fizz, 'references'), { recursive: true })
  writeFileSync(join(fizz, 'references/critic-pass.md'), pass())
  return fizz
}

function suited(bench: string, files: Record<string, string>): void {
  const dir = join(bench, 'test/fizz')
  suites.add(dir)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

function legs(stop?: string, mapped = false, suite: Record<string, string> = {}, filled = FILLED, fixes: Record<string, Record<string, string>> = {}) {
  const handoffs = join(mkdtempSync(join(tmpdir(), 'cf-fizz-stop-')), 'test/fizz/fizz_data/handoff')
  mkdirSync(handoffs, { recursive: true })
  const fires: { phase: string; issue: string }[] = []
  const { db, root: bench, run } = benched((packet, phase) => {
    fires.push({ phase, issue: packet.prompt })
    writeFileSync(join(handoffs, `${phase}.md`), filled[phase] ?? '')
    if (mapped) writeFileSync(join(handoffs, 'map.md'), `## Guards\n\n- V.deposit | reverts: ${phase}\n`)
    suited(bench, fixes[phase] ?? {})
    return { usage: { input: 0, cache: 0, output: 10 }, seconds: 2 }
  }, [fizzed()])
  suited(bench, suite)
  return { db, bench, handoffs, fires, run: () => run(skill, handoffs, stop) }
}

const critics = (db: Db): string[][] => eventsAfter(db, 0).filter((e) => e.kind === 'critic').map((e) => [e.outcome, e.message])

test('D2: an untolerated convertToAssets assertEq fires a fix', async () => {
  const { db, fires, run } = legs(undefined, false, { 'Suite.sol': CONVERTED })
  await run()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants', 'invariants-fix-critic-1', 'invariants-fix-critic-2'])
  expect(fires[4]?.issue).toContain('critic found:\n- test/fizz/Suite.sol:1:')
  expect(critics(db)).toEqual([['refuse', 'not_clean: critic'], ['pass', 'critic.stand_in']])
})

test('D3: a MockOracle with no stand-in limits fixes at the end', async () => {
  const { fires, run } = legs(undefined, false, { 'Mock.sol': MOCK }, FILLED, { 'end-fix-critic-1': CLEAN })
  await run()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants', 'end-fix-critic-1'])
  expect(fires[4]?.issue).toContain('critic found:\n- test/fizz/Mock.sol')
})

test('D4: hits a fix leaves land in critic.md, run goes on', async () => {
  const { db, handoffs, run } = legs(undefined, false, { 'Suite.sol': CONVERTED })
  expect(await run()).toMatchObject({ tokens: 60, wall: null })
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'fix.turn').map((e) => e.message)).toEqual([1, 2].map((turn) => JSON.stringify({ turn, tokens: 10, usd: 0 })))
  expect(critics(db)[0]).toEqual(['refuse', 'not_clean: critic'])
  expect(readFileSync(join(handoffs, 'critic.md'), 'utf8')).toBe(`critic.share_converted: test/fizz/Suite.sol:1:${CONVERTED}`)
})

test('D5: a clean suite fires no fix, logs two critic passes', async () => {
  const { db, handoffs, fires, run } = legs(undefined, false, CLEAN)
  await run()
  expect(fires).toHaveLength(4)
  expect(critics(db)).toEqual([['pass', 'critic.share_converted'], ['pass', 'critic.stand_in']])
  expect(existsSync(join(handoffs, 'critic.md'))).toBe(false)
})

test('D6: a twice-refused invariants handoff skips the critic', async () => {
  const { handoffs, fires, run } = legs(undefined, false, { 'Mock.sol': MOCK }, { ...FILLED, invariants: '' })
  expect(await run()).toMatchObject({ outcome: 'needs_coo', note: 'invariants handoff refused twice on the same span' })
  expect(fires.filter((f) => f.phase.includes('-fix-critic-'))).toEqual([])
  expect(existsSync(join(handoffs, 'critic.md'))).toBe(false)
})

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

test('a retry resumes at the first phase not yet passed', async () => {
  const filled = { ...FILLED, coverage: '' }
  const { handoffs, fires, run } = legs(undefined, false, {}, filled)
  expect(await run()).toMatchObject({ outcome: 'needs_coo' })
  filled.coverage = FILLED.coverage ?? ''
  const before = fires.length
  expect(await run()).toMatchObject({ tokens: 40, seconds: 8, wall: null })
  expect(fires.slice(before).map((f) => f.phase)).toEqual(['coverage', 'invariants'])
  expect(existsSync(join(handoffs, 'stopped.json'))).toBe(false)
})

const AT = [{ file: 'src/V.sol', start: 9, end: 9 }]
const MISSES: Miss[] = [{ kind: 'read.map_miss', file: 'src/V.sol', lines: 'L1-end' }, { kind: 'read.slice_miss', file: 'src/V.sol', lines: 'L12-L30' }]

async function mapped(map = '## Guards\n\n- V.deposit | reverts: cap | at: src/V.sol L9-L9\n', appended: Record<string, string> = {}, wrote: Record<string, Record<string, string>> = {}, report = true,
  batched = false, ends: Record<string, Partial<Fired>> = {}) {
  const handoffs = join(mkdtempSync(join(tmpdir(), 'cf-fizz-mapped-')), 'test/fizz/fizz_data/handoff')
  mkdirSync(join(handoffs, 'excerpts'), { recursive: true })
  writeFileSync(join(handoffs, 'map.md'), map)
  if (report) {
    mkdirSync(join(handoffs, '../corpus_medusa/coverage'), { recursive: true })
    writeFileSync(join(handoffs, '../corpus_medusa/coverage/revert_report.json'), '{}')
  }
  const packets: Packet[] = []
  const fires: { phase: string; issue: string; map: string }[] = []
  const { db, root, run } = benched((packet, phase) => {
    packets.push(packet)
    fires.push({ phase, issue: packet.prompt, map: readFileSync(join(handoffs, 'map.md'), 'utf8') })
    appendFileSync(join(handoffs, 'map.md'), appended[phase] ?? '')
    writeFileSync(join(handoffs, `${phase}.md`), FILLED[phase] ?? '')
    for (const [file, text] of Object.entries(wrote[phase] ?? {})) writeFileSync(join(handoffs, file), text)
    return phase === 'scaffold' ? { misses: MISSES } : ends[phase] ?? {}
  }, [fizzed()], batched)
  return { db, root, handoffs, packets, fires, sum: await run(skill, handoffs), rerun: () => run(skill, handoffs) }
}

test('D7: a mapped run calls each check once, in phase order', async () => {
  vi.clearAllMocks()
  let covered = true
  vi.mocked(primed).mockImplementationOnce((dir) => { covered = existsSync(join(dir, 'test/fizz/fizz_data/handoff/coverage.md')); return { off: null, clamped: [] } })
  await mapped()
  const at = (f: (...args: never[]) => unknown): number[] => vi.mocked(f).mock.invocationCallOrder
  expect([at(smoke).length, at(primed).length, at(reach).length, covered]).toEqual([1, 1, 1, false])
  expect(vi.mocked(criticCheck).mock.calls.map((call) => call[2])).toEqual(['critic.stand_in', 'critic.share_converted', 'critic.stand_in'])
  const [[smoked], [slithered], [reached], [stood, shared, ended]] = [at(smoke), at(primed), at(reach), at(criticCheck)]
  const order = [smoked, stood, slithered, reached, shared, ended]
  expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)))
  expect(vi.mocked(compiled).mock.calls.map((call) => call[1])).toEqual(['scaffold', 'smoke', 'coverage', 'invariants'])
})

test('D2: context is ranged, later phases carry map.md ranges', async () => {
  const { packets, sum } = await mapped()
  expect(sum).toMatchObject({ tokens: 5, wall: null })
  expect(packets.map((p) => [p.ranged, p.map])).toEqual([[true, undefined], ...Array<unknown>(4).fill([undefined, { ranges: AT, slice: AT }])])
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

const RAW: Suite['handlers'][number] = { file: 'test/fizz/H.sol', start: 1, end: 1, name: 'V_deposit', clamped: false, targets: ['V.deposit'], clamps: [] }
const SMOKED: Smoked[] = [{ name: 'V.deposit(uint256 assets)', calls: 10, successes: 4 }]

test('D2-D4: a suite refusal fires a fix turn before coverage', async () => {
  vi.mocked(suite).mockReturnValueOnce(EMPTY).mockReturnValueOnce({ ...EMPTY, handlers: [RAW] })
  vi.mocked(smoke).mockReturnValueOnce({ results: SMOKED, note: null, cache: null, clamped: [] })
  const { db, handoffs, packets, fires } = await mapped('## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n')
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold-fix-suite-1', 'coverage', 'invariants-plan', 'invariants'])
  expect(fires[2]?.issue).toContain('scaffold: V.deposit has no raw handler')
  expect(['forge build --force', 'forge clean', 'forge build'].map((command) => admitted(packets[2]?.tools ?? [], command))).toEqual([false, false, true])
  expect(fires[2]?.issue).toContain('Never run forge build --force or forge clean')
  expect(fires[3]?.issue).toContain(packed(SMOKED))
  expect(readFileSync(join(handoffs, 'map.md'), 'utf8')).toContain('## Handlers\n\n- V_deposit | target: V.deposit | clamps: none | at: test/fizz/H.sol L1-L1\n')
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'fix.turn')).toEqual([
    { plan: 1, kind: 'fix.turn', actor: 'fizz_lean_generator', outcome: 'pass', message: '{"turn":1,"tokens":1,"usd":0}', pointer: null, run: null },
  ])
})

test.each([
  ['smoke.hung', 'smoke: medusa ran past --timeout 120 + 60 s and its process group was killed; last 40 lines:\nline 50'],
  ['smoke.compile_slow', 'smoke: forge build --ast --build-info ran past its 1200 s limit and was stopped after 1200 s; medusa did not run'],
  ['smoke.no_report', 'smoke: run_medusa.js exited 6 and wrote no test/fizz/fizz_data/corpus_medusa/coverage/revert_report.json; last 40 lines:\nline 50'],
])('a %s smoke refuses without a fix turn', async (rule, note) => {
  vi.mocked(smoke).mockReturnValueOnce({ rule, note })
  const { db, fires, sum } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold'])
  expect(sum).toEqual({ outcome: 'refuse', spans: [rule], note })
  expect(eventsAfter(db, 0).filter((e) => e.kind.startsWith('smoke.')).map((e) => [e.kind, e.outcome, e.message])).toEqual([[rule, 'refuse', note]])
})

test('a slither-off smoke logs smoke.slither_off and passes', async () => {
  const note = 'smoke: slither . --ignore-compile --print echidna --json - exited 1; medusa ran with slither off'
  vi.mocked(smoke).mockReturnValueOnce({ results: [], note, cache: null, clamped: [] })
  const { db, fires, sum } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants-plan', 'invariants'])
  expect(sum).toMatchObject({ tokens: 5, wall: null })
  expect(eventsAfter(db, 0).filter((e) => e.kind.startsWith('smoke.')).map((e) => [e.kind, e.outcome, e.message])).toEqual([['smoke.slither_off', 'pass', note]])
})

test('an off primed logs coverage.slither_off and coverage fires', async () => {
  const note = 'smoke: slither . --ignore-compile --foundry-out-directory cache/fizz-slither-out --print echidna --json - exited 1; medusa ran with slither off'
  vi.mocked(primed).mockReturnValueOnce({ off: note, clamped: [] })
  const { db, fires } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'invariants-plan', 'invariants'])
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'coverage.slither_off').map((e) => [e.outcome, e.message])).toEqual([['pass', note]])
})

test('a clamped balance logs smoke.clamped and coverage.clamped', async () => {
  const over = '0xffffffffffffffffffffffffffffffffffffffffffffffff'
  const message = `targetContractsBalances ${over} clamped to 1e24 wei`
  const clamps = (db: Db): string[][] => eventsAfter(db, 0).filter((e) => e.kind.endsWith('.clamped')).map((e) => [e.kind, e.outcome, e.message])
  vi.mocked(smoke).mockReturnValueOnce({ results: [], note: null, cache: null, clamped: [over] })
  vi.mocked(primed).mockReturnValueOnce({ off: null, clamped: [over] })
  expect(clamps((await mapped()).db)).toEqual([['smoke.clamped', 'pass', message], ['coverage.clamped', 'pass', message]])
  expect(clamps((await mapped()).db)).toEqual([])
})

test('a clamp from a smoke before its fix turn is still logged', async () => {
  const over = '0xffffffffffffffffffffffffffffffffffffffffffffffff'
  vi.mocked(suite).mockReturnValueOnce({ ...EMPTY, handlers: [RAW] })
  vi.mocked(smoke).mockReturnValueOnce({ results: [{ name: 'V.deposit(uint256 assets)', calls: 10, successes: 0 }], note: null, cache: null, clamped: [over] })
  const { db, fires } = await mapped('## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n')
  expect(fires.map((f) => f.phase)).toContain('scaffold-fix-smoke-1')
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'smoke.clamped').map((e) => [e.outcome, e.message]))
    .toEqual([['pass', `targetContractsBalances ${over} clamped to 1e24 wei`]])
})

test('a missing out/ is rebuilt before the scaffold check reads it', async () => {
  vi.clearAllMocks()
  vi.mocked(compiled).mockImplementationOnce((dir) => {
    mkdirSync(join(dir, 'out'))
    suites.add(join(dir, 'out'))
    return []
  })
  vi.mocked(suite).mockImplementationOnce((await vi.importActual<{ suite: typeof suite }>('../../../templates/suite.ts')).suite)
  const { handoffs, fires } = await mapped()
  expect(fires.map((f) => f.phase)).not.toContain('scaffold-fix-suite-1')
  expect(vi.mocked(compiled)).toHaveBeenCalledWith(join(handoffs, '../../../..'), 'scaffold')
})

test('a misaimed suite needs the COO and fires no fix turn', async () => {
  const [note, lcov] = ['scaffold: V.deposit has no raw handler, yet lcov.info hits src/V.sol L9-L9', 'SF:/repo/src/V.sol\nDA:9,1\nend_of_record\n']
  vi.mocked(misaimed).mockReturnValueOnce([{ rule: 'suite.misread', note }])
  const { fires, sum } = await mapped('## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n', {},
    { scaffold: { '../corpus_medusa/coverage/lcov.info': lcov } })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold'])
  expect(sum).toEqual({ outcome: 'needs_coo', spans: ['machine_fault', 'suite.misread'], note })
  expect(vi.mocked(misaimed).mock.lastCall?.[2]).toBe(lcov)
})

test("a broken build is the scaffold fix turn's hit", async () => {
  vi.mocked(compiled).mockReturnValueOnce([{ rule: 'handoff.ast', note: 'scaffold: forge build --ast failed: boom' }])
  const { fires } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold-fix-suite-1', 'coverage', 'invariants-plan', 'invariants'])
  expect(fires[2]?.issue).toContain('suite found:\n- scaffold: forge build --ast failed: boom')
})

const UNMET: Item = { key: 'Guards V.deposit', met: false, cells: ['passing: no', 'reverting: yes'], note: 'Guards V.deposit: passing never seen', reverts: [], located: true, misread: false }
const UNREACHABLE = (reason: string): string => `\n## Unreachable\n\n- Guards V.deposit | reason: ${reason}\n`
const LEAN = ['context', 'scaffold', 'coverage']

test('reach D1 D2: an unmet item fires one fix before invariants', async () => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { handoffs, fires } = await mapped(undefined, { 'coverage-fix-reach-1': UNREACHABLE('only the bridge calls it') })
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'coverage-fix-reach-1', 'invariants-plan', 'invariants'])
  expect(fires[3]?.issue).toContain(`reach found:\n- ${UNMET.note}`)
  expect(fires[5]?.map).toContain('## Reach\n\n- Guards V.deposit | met: no | passing: no | reverting: yes\n')
  expect(fires[5]?.issue).toContain(`Read ${join(handoffs, 'map.md')} and the excerpts`)
})

test.each([{ name: 'nothing', text: '' }, { name: 'a placeholder', text: UNREACHABLE('<why no input reaches it>') }])('reach D3: a fix writing $name refuses', async ({ text }) => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { db, fires } = await mapped(undefined, { 'coverage-fix-reach-1': text })
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'coverage-fix-reach-1', 'coverage-fix-reach-2', 'invariants-plan', 'invariants'])
  expect(eventsAfter(db, 0).filter((e) => ['reach.boundary', 'critic'].includes(e.kind)).map((e) => [e.kind, e.outcome, e.message])).toEqual([
    ['critic', 'refuse', 'not_clean: reach'], ['reach.boundary', 'refuse', JSON.stringify({ met: false, reasons: [UNMET.note] })],
    ['critic', 'pass', 'critic.share_converted'], ['critic', 'pass', 'critic.stand_in'],
  ])
})

test('reach D4: all met logs one pass and fires no fix', async () => {
  vi.mocked(reach).mockReturnValueOnce([{ ...UNMET, met: true, note: '' }])
  const { db, handoffs, fires } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'invariants-plan', 'invariants'])
  expect(vi.mocked(reach).mock.lastCall?.slice(2, 4)).toEqual(['coverage/lcov.info', 'coverage/revert_report.json'].map((f) => join(handoffs, '../corpus_medusa', f)))
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'reach.boundary').map((e) => [e.outcome, e.message])).toEqual([['pass', '{"met":true,"reasons":[]}']])
})

const OUTSIDE = '\n## Outside dependencies\n\n- Permit2 | role: x\n'
const ONLY = 'suite.outside,reach.unmet,reach.boundary'
const PERMIT2 = { rule: 'suite.outside', note: 'scaffold: Permit2 under ## Outside dependencies has no stand-in and is not deployed in setup()' }
const ROWS = [PERMIT2, { rule: 'reach.unmet', note: UNMET.note }, { rule: 'reach.boundary', note: UNMET.note }]
const ENTERED = '## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n'

/** `mapped(map)` and its report on a plan whose target.yml lists all three report-only checks, the target.yml removed after. */
async function reportOnly(map: string) {
  const { root } = benched(() => ({}))
  put(root, 1, 'target.yml', `report_only_checks: ${ONLY}\n`)
  try {
    const run = await mapped(map)
    report(run.db, run.root, 1, [], null)
    return run
  } finally {
    rmSync(join(planDir(root, 1), 'target.yml'))
  }
}

test('report-only checks fire no fix turn and log each row', async () => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { db, fires } = await reportOnly(`## Guards\n\n- V.deposit | reverts: cap | at: src/V.sol L9-L9\n${OUTSIDE}`)
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'invariants-plan', 'invariants'])
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'fix.turn' || (e.kind === 'critic' && e.outcome === 'refuse'))).toEqual([])
  expect(eventsAfter(db, 0).filter((e) => ['check.report_only', 'reach.boundary'].includes(e.kind)).map((e) => [e.kind, e.outcome, e.message])).toEqual([
    ...ROWS.map((row) => ['check.report_only', 'pass', JSON.stringify(row)]), ['reach.boundary', 'pass', JSON.stringify({ met: false, reasons: [UNMET.note] })],
  ])
})

test('a report-only check still fixes an unlisted suite row', async () => {
  vi.mocked(suite).mockReturnValueOnce(EMPTY).mockReturnValueOnce({ ...EMPTY, handlers: [RAW] })
  vi.mocked(smoke).mockReturnValueOnce({ results: SMOKED, note: null, cache: null, clamped: [] })
  const { db, fires } = await reportOnly(`${ENTERED}${OUTSIDE}`)
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'scaffold-fix-suite-1', 'coverage', 'invariants-plan', 'invariants'])
  expect(fires[2]?.issue).toContain('suite found:\n- scaffold: V.deposit has no raw handler\n')
  expect(fires[2]?.issue).not.toContain(PERMIT2.note)
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'check.report_only').map((e) => e.message)).toEqual([JSON.stringify(PERMIT2)])
})

test('report-only rows list in report.md only when listed', async () => {
  vi.mocked(reach).mockReturnValueOnce([UNMET])
  const { db, root } = await reportOnly(`## Guards\n\n- V.deposit | reverts: cap | at: src/V.sol L9-L9\n${OUTSIDE}`)
  const { report_only: listed, ...unlisted } = JSON.parse(get(root, 1, 'report.json')) as Record<string, unknown>
  expect(listed).toEqual({ checks: ONLY.split(','), rows: ROWS })
  const md = get(root, 1, 'report.md')
  expect(md).toMatch(/\n## Counted\n\n(- .*\n)+\n## Report-only checks\n\n- checks: suite\.outside; reach\.unmet; reach\.boundary\n- rows: rule suite\.outside, note scaffold: Permit2 .*; rule reach\.boundary, note Guards V\.deposit: passing never seen\n$/)
  report(db, root, 1, [], null)
  expect(JSON.parse(get(root, 1, 'report.json'))).toStrictEqual(unlisted)
  expect(get(root, 1, 'report.md')).toBe(md.slice(0, md.indexOf('\n## Report-only checks')))
})

test('an unlocated reach item refuses before any fix turn', async () => {
  vi.mocked(reach).mockReturnValueOnce([{ ...UNMET, located: false }])
  const { fires, sum } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(LEAN)
  expect(sum).toEqual({ outcome: 'refuse', spans: ['reach.unlocated'], note: '1 row(s) have no at: <file> L<start>-L<end> in map.md: Guards V.deposit' })
})

test('a misread reach item needs the COO and fires no fix turn', async () => {
  const key = 'Selected entry points V.deposit(uint256 assets)'
  vi.mocked(reach).mockReturnValueOnce([{ ...UNMET, key, misread: true }])
  const { fires, sum } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(LEAN)
  expect(sum).toEqual({ outcome: 'needs_coo', spans: ['machine_fault', 'reach.misread'],
    note: `1 entry point(s) read 0 calls through ## Handlers on lines lcov.info hit: ${key}` })
})

test('no revert report refuses before reach or any fix turn', async () => {
  vi.mocked(reach).mockClear()
  const { handoffs, fires, sum } = await mapped(undefined, {}, {}, false)
  expect(fires.map((f) => f.phase)).toEqual(LEAN)
  expect(sum).toEqual({ outcome: 'refuse', spans: ['coverage.no_revert_report'],
    note: `coverage: medusa wrote no ${join(handoffs, '../corpus_medusa/coverage/revert_report.json')}; the machine's coverage medusa.json does not set fuzzing.revertReporterEnabled` })
  expect(reach).not.toHaveBeenCalled()
  expect(readFileSync(join(handoffs, 'refire.txt'), 'utf8')).toBe('coverage.no_revert_report')
})

test('a grading throw needs the COO and fires no seat again', async () => {
  const message = "ENOENT: no such file or directory, open 'revert_report.json'\n    at readFileSync"
  vi.mocked(reach).mockImplementationOnce(() => { throw new Error(message) })
  const { fires, sum } = await mapped()
  expect(fires.map((f) => f.phase)).toEqual(LEAN)
  const first = "ENOENT: no such file or directory, open 'revert_report.json'"
  expect(sum).toEqual({ outcome: 'needs_coo', spans: ['machine_fault', `threw: ${first}`], note: `phase grading threw: ${first}`, message })
})

test('a rerun after a throw credits only the resumed phase', async () => {
  vi.mocked(reach).mockImplementationOnce(() => { throw new Error('boom') }).mockReturnValueOnce([UNMET])
  const { db, handoffs, rerun } = await mapped(undefined, { 'coverage-fix-reach-1': UNREACHABLE('only the bridge calls it') })
  const before = generated(db, 1).length
  await rerun()
  const runs = generated(db, 1).slice(before)
  expect(runs.map((r) => r.phase)).toEqual(['coverage', 'coverage-fix-reach-1', 'invariants-plan', 'invariants'])
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'bench.credit').map((e) => [e.actor, e.message, e.run]))
    .toEqual(runs.slice(0, 2).map((r) => ['machine', 'machine_fault, threw: boom', r.id]))
  expect(existsSync(join(handoffs, 'refire.txt'))).toBe(false)
})

test('a stopped.json sum without runs resumes from []', async () => {
  const { handoffs, run } = legs()
  writeFileSync(join(handoffs, 'context.md'), FILLED.context ?? '')
  writeFileSync(join(handoffs, 'stopped.json'), JSON.stringify({ phase: 'context', sum: { tokens: 10, seconds: 2, usd: 0, transcripts: [], wall: null }, smoked: '' }))
  expect(await run()).toMatchObject({ tokens: 40, machine: 0, runs: [1, 2, 3] })
})

test('a database is locked throw is not caught', async () => {
  vi.mocked(reach).mockImplementationOnce(() => { throw new Error('database is locked') })
  await expect(mapped()).rejects.toThrow('database is locked')
})

test('a not_clean scaffold passing its grade resumes at coverage', async () => {
  vi.mocked(reach).mockReturnValueOnce([{ ...UNMET, located: false }])
  const { db, handoffs, fires, sum, rerun } = await mapped('## Selected entry points\n\n- V.deposit(uint256 assets) | tier: 1\n\n## Unclamped\n\n- V.deposit | reason: any amount\n')
  expect(sum).toMatchObject({ outcome: 'refuse', spans: ['reach.unlocated'] })
  expect(critics(db)).toContainEqual(['refuse', 'not_clean: suite'])
  expect(JSON.parse(readFileSync(join(handoffs, 'stopped.json'), 'utf8'))).toMatchObject({ phase: 'scaffold' })
  const before = fires.length
  vi.mocked(primed).mockClear()
  await rerun()
  expect(fires[before]?.phase).toBe('coverage')
  expect(primed).toHaveBeenCalledOnce()
})

test('reach D5: coverage.md and the # Map block carry reach', () => {
  expect(phase('coverage')).toContain('- The machine checks map.md after you end: it writes ## Reach, one row per selected entry point, guard, limit and conversion point with met: yes or no; read it in {META_DIR}/handoff/map.md and never edit it.\n'
    + '- The machine checks each met: no row of ## Reach: make it reachable, or write a map.md ## Unreachable row <that row\'s first cell> | reason: <why no input reaches it>.\n')
  expect(readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8')).toContain('## Unclamped\n\n- <Contract.function> | reason: <why it has no clamped handler>\n\n'
    + '## Unreachable\n\n- <the ## Reach row\'s first cell> | reason: <why no input reaches it>\n\n# Candidates')
})

const AGGREGATE = '## Aggregates\n\n- V.totalAssets | movers: V.deposit | at: src/V.sol L9-L9\n'
const planOf = (relies: string): string => `## Rows\n\n- p1 | relies: ${relies} | implementer: global\n\n## Skipped\n\n- none\n`
const REPORTS = ['global', 'specific'].map((who) => `../reports/invariants-${who}-property-implementer.md`)

test('invariants D3 D5: an unused aggregate fixes the plan first', async () => {
  const relied = planOf('aggregates-1')
  const { db, handoffs, fires } = await mapped(AGGREGATE, {}, { 'invariants-plan': { 'plan.md': planOf('guards-1') }, 'invariants-fix-synthesizer-1': { 'plan.md': relied } })
  expect(fires.map((f) => f.phase)).toEqual([...LEAN, 'invariants-plan', 'invariants-fix-synthesizer-1', 'invariants'])
  expect(fires[3]?.issue).toContain(`Run Steps 9a-9c only, and end once the Synthesizer has written ${join(handoffs, 'plan.md')}`)
  expect(fires[4]?.issue).toContain('synthesizer found:\n- plan: aggregates-1 is in no row\'s relies:')
  const { global, specific } = packets(relied, fires[5]?.map ?? '', join(handoffs, 'excerpts'), '', [])
  expect(fires[5]?.issue).toContain(`Run Steps 9d-9e.\n## Global packet\n\n${global}\n## Specific packet\n\n${specific}`)
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'fix.turn')).toHaveLength(1)
})

test('invariants D1: a mapped run writes five slices', async () => {
  const { handoffs } = await mapped()
  expect(readdirSync(join(handoffs, '../reports/slices'))).toHaveLength(5)
})

test('invariants D6: a ghost both implementers declare is resent', async () => {
  const { db, fires } = await mapped(undefined, {}, { invariants: Object.fromEntries(REPORTS.map((report) => [report, 'function ghost() {}\n'])) })
  const invariants = fires.filter((f) => f.phase === 'invariants')
  expect(invariants).toHaveLength(2)
  expect(invariants[1]?.issue).toContain('Your handoff was refused:\n- plan.duplicate: plan: function ghost is declared by both implementers')
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'plan.duplicate').map((e) => e.outcome)).toEqual(['refuse'])
})

const TWO = '## Guards\n\n- V.deposit | reverts: cap | at: src/V.sol L9-L9\n- W.withdraw | reverts: cap | at: src/W.sol L9-L9\n'
const SPLIT = `## Rows\n\n${[...Array<string>(10).fill('guards-1'), 'guards-2'].map((id, i) => `- p${String(i)} | relies: ${id} | implementer: global\n`).join('')}\n## Skipped\n\n- none\n`
const TESTER = 'pragma solidity ^0.8.0;\nimport "./Properties.sol";\ncontract FuzzTester is Properties {}\n'
const BATCHED = [...LEAN, 'invariants-plan', 'invariants-batch-1', 'invariants-batch-2']

const v5 = (bodies = ['function a() public {}', 'function b() public {}'], ends: Record<string, Partial<Fired>> = {}) => mapped(TWO, {}, {
  'invariants-plan': { 'plan.md': SPLIT, '../../FuzzTester.sol': TESTER },
  'invariants-batch-1': { '../../PropertiesBatch1.sol': `contract PropertiesBatch1 { ${bodies[0] ?? ''} }\n` },
  'invariants-batch-2': { '../../PropertiesBatch2.sol': `contract PropertiesBatch2 { ${bodies[1] ?? ''} }\n`, 'invariants.md': FILLED.invariants ?? '' },
}, true, true, ends)

test('a v5 run fires one fresh session per batch', async () => {
  const { db, handoffs, fires } = await v5()
  expect(fires.map((f) => f.phase)).toEqual(BATCHED)
  expect(generated(db, 1).map((r) => r.phase).filter((p) => p?.startsWith('invariants-batch-'))).toEqual(['invariants-batch-1', 'invariants-batch-2'])
  expect(fires.some((f) => f.issue.includes('## Global packet\n'))).toBe(false)
  expect(fires[4]?.issue).toContain('Run Step 9d for batch 1 of 2: write only test/fizz/PropertiesBatch1.sol and reports/invariants-batch-1.md.\n')
  expect(fires[4]?.issue).toContain(`## Batch packet\n\n## Rows\n\n- p0 | relies: guards-1`)
  expect(fires[4]?.issue).toContain(`## Harness skeleton\n\n\`\`\`solidity\n${TESTER}\`\`\``)
  expect(fires.slice(4).map((f) => f.issue.includes(`Before you end, write ${join(handoffs, 'invariants.md')}`))).toEqual([false, true])
})

test('a crashed batch refires alone; a rerun fires only it', async () => {
  const ends: Record<string, Partial<Fired>> = { 'invariants-batch-2': { ended: 'stopped', usage: { input: 0, cache: 0, output: 500, cost: 7 } } }
  const { packets, fires, sum, rerun } = await v5(undefined, ends)
  expect(fires.map((f) => f.phase)).toEqual([...BATCHED, 'invariants-batch-2'])
  expect(sum).toEqual({ outcome: 'refuse', spans: ['seat.exit'], note: 'fizz_lean_generator invariants-batch-2 stopped' })
  const [crashed, refired] = packets.slice(-2)
  expect((crashed?.wall ?? 0) - (refired?.wall ?? 0)).toBe(500)
  expect((crashed?.cost_wall?.usd ?? 0) - (refired?.cost_wall?.usd ?? 0)).toBe(7)
  const before = fires.length
  ends['invariants-batch-2'] = {}
  expect(await rerun()).toMatchObject({ wall: null })
  expect(fires.slice(before).map((f) => f.phase)).toEqual(['invariants-batch-2'])
})

test('a batched plan at the wall is held for the CEO', async () => {
  const { fires, sum } = await v5(undefined, { 'invariants-batch-1': { usage: { input: 0, cache: 0, output: 1, cost: 100 } } })
  expect(fires.map((f) => f.phase)).toEqual(BATCHED.slice(0, -1))
  expect(sum).toEqual({ outcome: 'needs_ceo', spans: ['bench.cost_wall'], note: 'plan 1 spent $100.00 gross against the $100 bench.cost_wall_usd wall' })
})

test('a v5 run compiles once after the last batch, then inherits', async () => {
  vi.clearAllMocks()
  const { handoffs } = await v5()
  expect(vi.mocked(compiled).mock.calls.map((call) => call[1])).toEqual(['scaffold', 'smoke', 'coverage', 'invariants', 'merge'])
  expect(readFileSync(join(handoffs, '../../FuzzTester.sol'), 'utf8')).toBe('pragma solidity ^0.8.0;\nimport "./Properties.sol";\nimport "./PropertiesBatch1.sol";\n'
    + 'import "./PropertiesBatch2.sol";\ncontract FuzzTester is Properties, PropertiesBatch1, PropertiesBatch2 {}\n')
  expect(JSON.parse(readFileSync(join(handoffs, 'manifest.json'), 'utf8'))).toEqual(['test/fizz/PropertiesBatch1.sol', 'test/fizz/PropertiesBatch2.sol'])
})

test('two batches declaring one function refuse, no compile', async () => {
  vi.clearAllMocks()
  const { sum } = await v5(['function f() public {}', 'function f() public {}'])
  expect(sum).toEqual({ outcome: 'refuse', spans: ['plan.duplicate'], note: 'plan: function f is declared by test/fizz/PropertiesBatch1.sol, test/fizz/PropertiesBatch2.sol' })
  expect(vi.mocked(compiled).mock.calls.map((call) => call[1])).not.toContain('merge')
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

const touched = (name: string, state: string) => ({ functions: [{ file: 'src/V.sol', start: 9, end: 9, name }], state: [state] })

test('a context grade that misses stops before scaffold', async () => {
  FIXED.mockReturnValueOnce(touched('V.setFee', 'V.fee')).mockReturnValueOnce(touched('V.setFee', 'V.fee'))
  const { db, bench, handoffs, fires, run } = legs()
  put(bench, 1, 'target.yml', 'target: v\ngenerator: fizz_lean_generator\n')
  expect(await run()).toEqual({ outcome: 'needs_coo', spans: ['bench.grade'], note: 'miss: context names none of V.setFee' })
  await run()
  expect(fires.map((f) => f.phase)).toEqual(['context', 'context'])
  expect(existsSync(join(handoffs, 'stopped.json'))).toBe(false)
  expect(scores(db).map((s) => [s.not_powered, s.tokens, s.seconds])).toEqual([['context_missed', 10, 2], ['context_missed', 10, 2]])
  expect(underpowered(db)).toHaveLength(1)
})

test('grades that all hit fire every phase', async () => {
  FIXED.mockClear().mockReturnValueOnce(touched('V.deposit', 'V.cap'))
  const { db, handoffs, fires, run } = legs()
  const [dir, coverage] = [join(handoffs, '../../../..'), join(handoffs, '../corpus_medusa/coverage')]
  mkdirSync(join(dir, 'test/fizz/handlers'), { recursive: true })
  mkdirSync(coverage, { recursive: true })
  writeFileSync(join(handoffs, 'map.md'), '## Limits\n\n- V.cap\n')
  writeFileSync(join(dir, 'test/fizz/handlers/H.sol'), 'v.deposit(1);\n')
  writeFileSync(join(dir, 'test/fizz/Properties.sol'), 'assert(v.cap() > 0);\n')
  writeFileSync(join(coverage, 'lcov.info'), `SF:${dir}/src/V.sol\nDA:9,1\nend_of_record\n`)
  expect(await run()).toMatchObject({ tokens: 40, wall: null })
  expect(fires.map((f) => f.phase)).toEqual(['context', 'scaffold', 'coverage', 'invariants'])
  expect(FIXED).toHaveBeenCalledOnce()
  expect(eventsAfter(db, 0).filter((e) => e.kind === 'bench.grade').map((e) => [e.outcome, e.message])).toEqual([
    ['pass', 'context: hit V.deposit, V.cap'], ['pass', 'scaffold: hit V.deposit, V.cap'], ['pass', 'coverage: hit V.deposit'],
  ])
})

test.each(CHECKS.map(([heading]) => heading))('D6: a critic pass with no sh block under %s throws', (heading) => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fizz-critic-'))
  writeFileSync(join(dir, 'critic-pass.md'), pass(heading))
  expect(() => critic(join(dir, 'critic-pass.md'), dir)).toThrow(`${join(dir, 'critic-pass.md')} has no sh block under ${heading}`)
})
