import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { below, compiled, type Node } from '../../../templates/extract.ts'
import { layered } from '../../../templates/handoff.ts'
import { selected, suited } from '../../../templates/map.ts'
import { harnessed, misaimed, probed, type Suite, suite, unsourced } from '../../../templates/suite.ts'

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
    { ...at(32, 35), name: 'Harness.v_deposit', clamped: false, targets: ['V.deposit'], clamps: [] },
    { ...at(37, 39), name: 'Harness.v_deposit_clamped', clamped: true, targets: ['V.deposit'], clamps: [{ text: 'bound(assets, 0, 1e24)', range: '1e24' }] },
    { ...at(41, 43), name: 'Harness.v_withdraw', clamped: false, targets: ['V.withdraw'], clamps: [] },
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
  const outside = map({ 'Outside dependencies': ['- Oracle | limits: 1e6 per update', '- asset ERC20 (MockERC20 stand-in) | limits: 1e6 per update',
    '- Feed | limits: one answer per block', '- MockERC20s pool | limits: one answer per block'].join('\n') })
  const refused = ['Feed', 'MockERC20s pool']
    .map((name) => ({ rule: 'suite.outside', note: `scaffold: ${name} under ## Outside dependencies has no stand-in and is not deployed in setup()` }))
  const mock = { ...at(16, 18), name: 'MockERC20', replaces: 'ERC20', limits: [] }
  expect(harnessed({ ...FOUND, standIns: [...FOUND.standIns, mock] }, outside)).toEqual(refused)
  expect(harnessed({ ...FOUND, deployed: [...FOUND.deployed, { ...at(25, 25), contract: 'MockERC20', args: [] }] }, outside)).toEqual(refused)
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

const BASE = 'test/fizz/Base.sol'
const BASE_AST = readFileSync(join(fixtures, 'Base.ast.json'), 'utf8')
const lines = (start: number, end = start): { file: string; start: number; end: number } => ({ file: BASE, start, end })
const FACTORY = { ...lines(15), contract: 'EulerEarnFactory', args: ['admin', 'evc', 'perspective', 'asset'] }
const EULER: Suite = {
  deployed: [FACTORY, { ...lines(16), contract: 'EulerEarn', args: ['admin', '0', 'address(asset)', '"Euler Earn Asset"', '"eeAST"', 'bytes32(0)'], via: 'factory' }],
  actors: ['admin', 'evc', 'perspective', 'asset'].map((name, i) => ({ ...lines(7 + i), name: `Base.${name}`, roles: [] })),
  handlers: [
    { ...lines(19, 21), name: 'Base.eulerEarn_acceptCap', clamped: false, targets: ['EulerEarn.acceptCap'], clamps: [] },
    { ...lines(23, 25), name: 'Base.eulerEarn_acceptCap_clamped', clamped: true, targets: ['EulerEarn.acceptCap'], clamps: [{ text: 'id % 4', range: '4' }] },
  ],
  standIns: [],
  probes: [],
  trackers: [],
  build: FOUND.build,
}
const ACCEPT = '## Selected entry points\n\n- EulerEarn.acceptCap(uint256 newSupplyCap) | tier: 1\n\n'
  + '## Signatures\n\n- EulerEarn.acceptCap(uint256 newSupplyCap) | at: src/EulerEarn.sol L7-L9\n'
const lcov = (line: number, hits: number): string => `SF:/repo/src/EulerEarn.sol\nDA:${String(line)},${String(hits)}\nend_of_record\n`

type Loose = Node & { rightHandSide: Loose; arguments: [Loose, ...Loose[]] }

function based(ast: string | null = BASE_AST): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-base-'))
  for (const dir of ['out/Base.sol', 'src', 'test/fizz']) mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(join(fixtures, 'EulerEarn.sol'), join(root, 'src/EulerEarn.sol'))
  copyFileSync(join(fixtures, 'Base.sol'), join(root, BASE))
  if (ast !== null) writeFileSync(join(root, 'out/Base.sol/Base.json'), ast)
  writeFileSync(join(root, 'medusa.json'), JSON.stringify(MEDUSA))
  writeFileSync(join(root, 'foundry.toml'), TOML)
  return root
}

function recast(change: (nodes: { vault: Loose; address: Loose; create: Loose }) => void): string {
  const built = JSON.parse(BASE_AST) as { ast: Node }
  const vault = below(built.ast).find((n) => n.leftHandSide?.name === 'vault') as Loose
  const address = vault.rightHandSide.arguments[0]
  change({ vault, address, create: address.arguments[0] })
  return JSON.stringify(built)
}

test('a factory-cast target is deployed and its handlers aimed', () => {
  const found = suite(based())
  expect(found).toEqual(EULER)
  expect(harnessed(found, ACCEPT)).toEqual([])
})

test.each([
  { name: 'a cast with no call', change: ({ address, create }) => { address.arguments = [create.arguments[0]] } },
  { name: 'a cast of a new', change: ({ create }) => { create.expression = { id: 990, nodeType: 'NewExpression', src: '412:23:0' } } },
  { name: 'an uncast call', change: ({ vault, create }) => { vault.rightHandSide = create } },
] satisfies { name: string; change: Parameters<typeof recast>[0] }[])('$name adds no factory row', ({ change }) => {
  expect(suite(based(recast(change))).deployed).toEqual([FACTORY])
})

test('an unaimed entry point that lcov hits is misread', () => {
  const unaimed = { ...EULER, handlers: [] }
  expect(misaimed(unaimed, ACCEPT, lcov(8, 3))).toEqual([
    { rule: 'suite.misread', note: 'scaffold: EulerEarn.acceptCap has no raw handler, yet lcov.info hits src/EulerEarn.sol L7-L9' },
  ])
  expect([misaimed(unaimed, ACCEPT, ''), misaimed(unaimed, ACCEPT, lcov(8, 0) + lcov(10, 4)), misaimed(EULER, ACCEPT, lcov(8, 3))]).toEqual([[], [], []])
})

test('a view read is skipped when a handler is aimed', () => {
  const built = JSON.parse(BASE_AST) as { ast: Node }
  const body = below(built.ast).find((n) => n.id === 273) as Node & { statements: [Node] }
  const [accept] = body.statements
  const read = structuredClone(accept)
  const access = (statement: Node): Node[] => below(statement).filter((n) => n.nodeType === 'MemberAccess')
  const view = { typeString: 'function (uint256) view external returns (uint136,uint64)' }
  for (const n of access(read)) Object.assign(n, { memberName: 'pendingCap', typeDescriptions: view })
  body.statements.unshift(read)
  expect(suite(based(JSON.stringify(built))).handlers).toEqual(EULER.handlers)
  for (const n of access(accept)) n.typeDescriptions = view
  const unaimed = suite(based(JSON.stringify(built)))
  expect(unaimed.handlers).toEqual(EULER.handlers.map((h) => ({ ...h, targets: [] })))
  expect(misaimed(unaimed, ACCEPT, lcov(8, 3))).toEqual([
    { rule: 'suite.misread', note: 'scaffold: EulerEarn.acceptCap has no raw handler, yet lcov.info hits src/EulerEarn.sol L7-L9' },
  ])
  wrapped((accept as Node & { expression: Loose }).expression)
  expect(suite(based(JSON.stringify(built))).handlers).toEqual(unaimed.handlers)
})

test('a handler aims every target its helpers reach', () => {
  const built = JSON.parse(BASE_AST) as { ast: Node }
  const body = (id: number): Node & { statements: [Node, ...Node[]] } => below(built.ast).find((n) => n.id === id) as Node & { statements: [Node, ...Node[]] }
  const submit = structuredClone(body(273).statements[0])
  for (const n of below(submit).filter((n) => n.nodeType === 'MemberAccess')) Object.assign(n, { memberName: 'submitCap' })
  body(263).statements.unshift(submit)
  const found = suite(based(JSON.stringify(built)))
  expect(found.handlers.map((h) => h.targets)).toEqual([['EulerEarn.acceptCap'], ['EulerEarn.submitCap', 'EulerEarn.acceptCap']])
  expect(harnessed(found, ACCEPT)).toEqual([])
})

function recalled(change: (call: Loose) => void): string {
  const built = JSON.parse(BASE_AST) as { ast: Node }
  const body = below(built.ast).find((n) => n.id === 273) as Node & { statements: [Node & { expression: Loose }] }
  change(body.statements[0].expression)
  return JSON.stringify(built)
}

function wrapped(call: Loose): void {
  call.expression = { id: 990, nodeType: 'FunctionCallOptions', src: call.src, expression: call.expression as Loose }
}

const encoded = (memberName: string) => (call: Loose): void => {
  call.arguments = [call.expression as Loose, ...call.arguments]
  call.expression = { id: 991, nodeType: 'MemberAccess', src: call.src, memberName, expression: { id: 992, nodeType: 'Identifier', src: call.src, name: 'abi' } }
}

test.each([
  { name: 'call options', change: wrapped, targets: ['EulerEarn.acceptCap'] },
  { name: 'abi.encodeCall', change: encoded('encodeCall'), targets: ['EulerEarn.acceptCap'] },
  { name: 'abi.encode', change: encoded('encode'), targets: [] },
])('a call through $name aims $targets', ({ change, targets }) => {
  const found = suite(based(recalled(change)))
  expect(found.handlers).toEqual(EULER.handlers.map((h) => ({ ...h, targets })))
  expect(misaimed(found, ACCEPT, lcov(8, 3))).toEqual(targets.length === 0 ? [
    { rule: 'suite.misread', note: 'scaffold: EulerEarn.acceptCap has no raw handler, yet lcov.info hits src/EulerEarn.sol L7-L9' },
  ] : [])
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('a fresh forge build of Base reads as its fixture', () => {
  const root = based(null)
  expect(compiled(root)).toEqual([])
  expect(suite(root)).toEqual(EULER)
}, 300_000)

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

const LIMITS = 'test/fizz/probes/LimitsProbes.sol'
const HEAD = /^abstract contract (\w+)[^{]*\{(?:\}|[\s\S]*?\n\})/gm
const LIMITED = [
  { start: 4, end: 4, name: 'ProbeEntropy', cites: null },
  { start: 7, end: 12, name: 'ProbeMaxTimelock', cites: 'ConstantsLib.MAX_TIMELOCK' },
  { start: 15, end: 20, name: 'ProbeMaxFee', cites: 'ConstantsLib.MAX_FEE' },
  { start: 24, end: 29, name: 'ProbeMaxQueueLength', cites: null },
  { start: 31, end: 31, name: 'Probes', cites: null },
].map((p) => ({ file: LIMITS, ...p, trackers: [], calls: [] }))

function limited(built = true): string {
  const root = project(built)
  const source = readFileSync(join(fixtures, 'LimitsProbes.sol'), 'utf8')
  mkdirSync(join(root, 'test/fizz/probes'))
  copyFileSync(join(fixtures, 'LimitsProbes.sol'), join(root, LIMITS))
  const nodes = [...source.matchAll(HEAD)].map((m, i) => ({ nodeType: 'ContractDefinition', src: `${String(m.index)}:${String(m[0].length)}:0`, id: i + 1, name: m[1], nodes: [] }))
  if (built) mkdirSync(join(root, 'out/LimitsProbes.sol'))
  if (built) writeFileSync(join(root, 'out/LimitsProbes.sol/LimitsProbes.json'), JSON.stringify({ ast: { nodeType: 'SourceUnit', src: '0:0:0', id: 0, absolutePath: LIMITS, nodes } }))
  return root
}

test('a probe cited on the line above its abstract head is read', () => {
  const found = suite(limited())
  expect(found.probes).toEqual(LIMITED)
  expect(probed(found, map({ Limits: ['MAX_TIMELOCK', 'MAX_FEE', 'MAX_QUEUE_LENGTH'].map((c) => `- ConstantsLib.${c}`).join('\n') }))).toEqual([
    { rule: 'suite.probe', note: 'scaffold: ## Limits ConstantsLib.MAX_QUEUE_LENGTH has no probe' },
  ])
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('a fresh forge build reads probes cited above their heads', () => {
  const root = limited(false)
  expect(compiled(root)).toEqual([])
  expect(suite(root).probes).toEqual(LIMITED)
}, 300_000)
