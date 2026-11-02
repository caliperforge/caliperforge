import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { compiled } from '../../../templates/extract.ts'
import { layered } from '../../../templates/handoff.ts'
import { selected, suited } from '../../../templates/map.ts'
import { harnessed, probed, type Suite, suite, unsourced } from '../../../templates/suite.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const SELECTION = readFileSync(join(fixtures, 'entry-point-selection.json'), 'utf8')
const MEDUSA = { compilation: { platform: 'crytic-compile', platformConfig: { target: '.', args: ['--foundry-compile-all'] } } }
const TOML = '[profile.default]\nvia_ir = true\noptimizer = true\n\n[profile.fuzz]\nvia_ir = false\n'
const HARNESS = 'test/fizz/Harness.sol'
const at = (start: number, end: number): { file: string; start: number; end: number } => ({ file: HARNESS, start, end })
const FOUND: Suite = {
  deployed: [{ ...at(23, 23), contract: 'V', args: [] }, { ...at(24, 24), contract: 'MockOracle', args: ['1e18'] }],
  actors: [{ ...at(19, 19), name: 'Harness.alice', roles: ['keccak256("FEEDER")'] }],
  handlers: [
    { ...at(32, 35), name: 'Harness.v_deposit', clamped: false, target: 'V.deposit', clamps: [] },
    { ...at(37, 39), name: 'Harness.v_deposit_clamped', clamped: true, target: 'V.deposit', clamps: [{ text: 'bound(assets, 0, 1e24)', range: '1e24' }] },
    { ...at(41, 43), name: 'Harness.v_withdraw', clamped: false, target: 'V.withdraw', clamps: [] },
  ],
  standIns: [{ ...at(6, 14), name: 'MockOracle', replaces: 'Oracle',
    limits: [{ limit: 'price within 1e6 of start', map: 'Oracle' }, { limit: 'deposits under 1e24', map: 'V.CAP' }] }],
  probes: [],
  trackers: [{ ...at(20, 20), name: 'Harness.ghostDeposits', type: 'uint256', writers: ['Harness.v_deposit'] }],
  build: { command: 'crytic-compile . --foundry-compile-all', via_ir: 'false', optimizer: 'true' },
}
const STAND_IN = [{ rule: 'suite.stand_in', note: 'scaffold: MockOracle limit "deposits under 1e24" cites no ## Limits or ## Outside dependencies row' }]
const CONVERT = { 'Conversion points': '- V.convertToAssets | at: src/V.sol L17-L19' }
const probe = (name: string, cites: string, calls: string[] = []): Suite['probes'][number] => ({ ...at(1, 1), name, cites, trackers: [], calls })
const [CAP, CONVERTS] = [probe('ProbeCap', 'V.CAP'), probe('ProbeConvert', 'V.convertToAssets')]
const PROBES = 'test/fizz/Probes.sol'

function project(built = true): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-suite-'))
  for (const dir of ['out/V.sol', 'out/Harness.sol', 'src', 'test/fizz']) mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Harness.sol'), join(root, HARNESS))
  if (built) copyFileSync(join(fixtures, 'V.ast.json'), join(root, 'out/V.sol/V.json'))
  if (built) copyFileSync(join(fixtures, 'Harness.ast.json'), join(root, 'out/Harness.sol/Harness.json'))
  writeFileSync(join(root, 'medusa.json'), JSON.stringify(MEDUSA))
  writeFileSync(join(root, 'foundry.toml'), TOML)
  return root
}

const map = (rows: Record<string, string> = {}): string => Object.entries({
  'Selected entry points': selected(SELECTION).map((r) => `- ${r}`).join('\n'),
  Limits: '- V.CAP | bound: totalAssets at most 1e24 | at: src/V.sol L5-L5',
  'Outside dependencies': '- Oracle | limits: price moves at most 1e6 per update',
  'Skipped entry points': '- V.convertToAssets | reason: a view, it changes no state',
  Unclamped: '- V.withdraw | reason: any amount the vault holds is valid',
  ...rows,
}).map(([name, row]) => `## ${name}\n\n${row}\n`).join('\n')

test('D1: suite reads the committed harness AST', () => {
  expect(suite(project())).toEqual(FOUND)
})

test('D2: a selected function with no clamped handler is refused', () => {
  expect(harnessed(FOUND, map({ Unclamped: '- none' }))).toEqual([{ rule: 'suite.clamped', note: 'scaffold: V.withdraw has no clamped handler and no ## Unclamped row' }])
  expect(harnessed(FOUND, map())).toEqual([])
})

test('D3: a stand-in limit citing no map row is refused', () => {
  expect(harnessed(FOUND, map({ Limits: '- none' }))).toEqual(STAND_IN)
})

test('D4: an outside dependency with no stand-in is refused', () => {
  expect(harnessed(FOUND, map({ 'Outside dependencies': '- Oracle | limits: 1e6 per update\n- Feed | limits: one answer per block' }))).toEqual([
    { rule: 'suite.outside', note: 'scaffold: Feed under ## Outside dependencies has no stand-in and is not deployed in setup()' },
  ])
})

test('D5: a clamp with no map row is listed, not refused', () => {
  expect(unsourced(FOUND, map())).toEqual([])
  expect(unsourced(FOUND, map({ Limits: '- none' }))).toEqual(['Harness.v_deposit_clamped: bound(assets, 0, 1e24)'])
  expect(harnessed(FOUND, map({ Limits: '- none' }))).toEqual(STAND_IN)
})

test('D6: suited writes the suite layer, scaffold owns Unclamped', () => {
  const layer = [
    `## Deployed\n\n- V | args: none | at: ${HARNESS} L23-L23\n- MockOracle | args: 1e18 | at: ${HARNESS} L24-L24\n`,
    `## Actors\n\n- Harness.alice | roles: keccak256("FEEDER") | at: ${HARNESS} L19-L19\n`,
    `## Handlers\n\n- Harness.v_deposit | target: V.deposit | clamps: none | at: ${HARNESS} L32-L35\n`
    + `- Harness.v_deposit_clamped | target: V.deposit | clamps: bound(assets, 0, 1e24) | at: ${HARNESS} L37-L39\n`
    + `- Harness.v_withdraw | target: V.withdraw | clamps: none | at: ${HARNESS} L41-L43\n`,
    `## Stand-ins\n\n- MockOracle | replaces: Oracle | limits: price within 1e6 of start (map: Oracle); deposits under 1e24 (map: V.CAP) | at: ${HARNESS} L6-L14\n`,
    `## Trackers\n\n- Harness.ghostDeposits | type: uint256 | writers: Harness.v_deposit | at: ${HARNESS} L20-L20\n`,
    '## Build\n\n- command | value: crytic-compile . --foundry-compile-all\n- via_ir | value: false\n- optimizer | value: true\n',
  ].join('\n')
  const before = suited(FOUND, `## Deployed\n\n- Stale | args: none\n\n${map()}`)
  expect(before).toBe(`${map()}\n${layer}`)
  const after = before.replace('any amount the vault holds is valid', 'withdraw takes no bound')
  expect(layered('coverage', before, after)).toEqual([{ rule: 'handoff.layer', note: 'coverage: ## Unclamped is the scaffold layer\'s and changed' }])
  expect(layered('scaffold', before, after)).toEqual([])
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('D7: a fresh forge build reads as D1', () => {
  const root = project(false)
  expect(compiled(root)).toEqual([])
  expect(suite(root)).toEqual(FOUND)
}, 300_000)

test('6/9 D1: a probe per limit and conversion passes', () => {
  expect(probed({ ...FOUND, probes: [CAP, CONVERTS] }, map(CONVERT))).toEqual([])
})

test('6/9 D2: a conversion point with no probe is refused', () => {
  expect(probed({ ...FOUND, probes: [CAP] }, map(CONVERT))).toEqual([
    { rule: 'suite.probe', note: 'scaffold: ## Conversion points V.convertToAssets has no probe' },
  ])
})

test('6/9 D3: a probe that makes a call is refused', () => {
  expect(probed({ ...FOUND, probes: [CAP, CONVERTS, probe('ProbeCalls', 'V.convertToAssets', ['v.convertToAssets(x)'])] }, map(CONVERT))).toEqual([
    { rule: 'suite.probe_call', note: 'scaffold: ProbeCalls calls v.convertToAssets(x); a probe makes no external call' },
  ])
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('6/9 D7: a fresh forge build reads each probe', () => {
  const root = project(false)
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, PROBES))
  expect(compiled(root)).toEqual([])
  const found = suite(root)
  expect(found.probes).toEqual([
    { file: PROBES, start: 6, end: 13, name: 'ProbeCap', cites: 'V.CAP', trackers: ['ProbeCap.maxTotal'], calls: [] },
    { file: PROBES, start: 15, end: 27, name: 'ProbeConvert', cites: 'V.convertToAssets', trackers: ['ProbeConvert.maxAssets', 'ProbeConvert.minAssets', 'ProbeConvert.saw1Wei'], calls: [] },
    { file: PROBES, start: 29, end: 37, name: 'ProbeCalls', cites: 'V.convertToAssets', trackers: ['ProbeCalls.lastAssets'], calls: ['v.convertToAssets(shares)'] },
  ])
  expect([found.handlers, found.trackers]).toEqual([FOUND.handlers, FOUND.trackers])
}, 300_000)
