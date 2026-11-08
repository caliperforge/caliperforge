import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import { compiled } from '../../../templates/extract.ts'
import { held, readings, trackers } from '../../../templates/probes.ts'
import type { Suite } from '../../../templates/suite.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<{ spawnSync: typeof spawnSync }>()
  return { ...original, spawnSync: vi.fn(original.spawnSync) }
})

const fixtures = join(import.meta.dirname, 'fixtures')
const TEST = 'test/fizz/ProbeReadings.t.sol'
const row = (name: string, cites: string | null, tracked: string[]): Suite['probes'][number] =>
  ({ file: 'test/fizz/Probes.sol', start: 1, end: 1, name, cites, trackers: tracked.map((t) => `${name}.${t}`), calls: [] })
const ROWS = [row('ProbeCap', 'V.CAP', ['maxTotal']), row('ProbeConvert', 'V.convertToAssets', ['maxAssets', 'minAssets', 'saw1Wei']),
  row('ProbeCalls', 'V.convertToAssets', ['lastAssets'])]
const VALUES: [string, bigint | boolean][] = [['ProbeCap.maxTotal', 10n ** 24n], ['ProbeConvert.maxAssets', 2n * 10n ** 24n],
  ['ProbeConvert.minAssets', 1n], ['ProbeConvert.saw1Wei', true], ['ProbeCalls.lastAssets', 5n]]
const HARNESS = 'pragma solidity ^0.8.20;\nimport {ProbeCap} from "./Probes.sol";\n'
  + 'contract FuzzTester {\n    ProbeCap cap;\n    constructor() { setup(); }\n    function setup() public { cap = new ProbeCap(); }\n'
  + '    function seen(uint256 t) external { cap.seen(t); }\n    function stop() external { revert(); }\n}\n'

function project(entry: string, targets = ['FuzzTester'], fuzzing = {}): { root: string; corpus: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-probes-'))
  const corpus = join(root, 'test/fizz/fizz_data/corpus_medusa')
  for (const dir of [join(root, 'out'), join(root, 'src'), join(corpus, 'call_sequences/immutable')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'test/fizz/FuzzTester.sol'), entry)
  writeFileSync(join(root, 'medusa.json'), JSON.stringify({ fuzzing: { targetContracts: targets, ...fuzzing } }))
  writeFileSync(join(root, 'foundry.toml'), '[profile.default]\n\n[profile.fuzz]\nvia_ir = false\n')
  return { root, corpus }
}

function sequenced(count: number): { root: string; corpus: string } {
  const made = project(HARNESS)
  for (let i = 0; i < count; i++) writeFileSync(join(made.corpus, `call_sequences/immutable/${String(i)}.json`), JSON.stringify([{ call: { from: '0x10000', data: '0x12345678' } }]))
  return made
}

function faked(tested: (cwd: string) => object): void {
  onTestFinished(() => { vi.mocked(spawnSync).mockReset() })
  vi.mocked(spawnSync).mockClear().mockImplementation(((...[, args, { cwd }]: [string, string[], { cwd: string }]) => args[0] === 'inspect'
    ? { status: 0, stdout: '{"storage":[],"types":{}}', stderr: '' } : tested(cwd)) as unknown as typeof spawnSync)
}

test('D1: readings fills the V.CAP limit and the conversion', () => {
  expect(readings(ROWS, new Map(VALUES))).toEqual({ limits: { 'V.CAP': { max: 10n ** 24n } },
    conversions: { 'V.convertToAssets': { min: 1n, max: 2n * 10n ** 24n, saw1Wei: true } } })
})

test('D2: probes sharing a cite merge max, min and saw1Wei', () => {
  const rows = [row('ProbeA', 'V.x', ['maxA', 'minA', 'sawA']), row('ProbeB', 'V.x', ['maxB', 'minB', 'sawB'])]
  const values = new Map<string, bigint | boolean>([['ProbeA.maxA', 3n], ['ProbeA.minA', 2n], ['ProbeA.sawA', false],
    ['ProbeB.maxB', 7n], ['ProbeB.minB', 1n], ['ProbeB.sawB', true]])
  expect(readings(rows, values)).toEqual({ limits: {}, conversions: { 'V.x': { min: 1n, max: 7n, saw1Wei: true } } })
})

test('D3: a cite with no value is left out, a missing one stays 0n', () => {
  const rows = [...ROWS, row('ProbeLoose', null, ['maxLoose'])]
  expect(readings(rows, new Map([['ProbeConvert.minAssets', 4n], ['ProbeLoose.maxLoose', 9n]]))).toEqual({ limits: {},
    conversions: { 'V.convertToAssets': { min: 4n, max: 0n, saw1Wei: false } } })
})

test('D4: ProbeCalls.lastAssets does not change the readings', () => {
  expect(readings(ROWS, new Map([...VALUES, ['ProbeCalls.lastAssets', 999n]]))).toEqual(readings(ROWS, new Map(VALUES)))
})

test('held maps true probe functions to their cite', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-probes-'))
  mkdirSync(join(root, 'test/fizz'), { recursive: true })
  const fn = (name: string): string => `    function ${name}() internal pure returns (bool) { return true; }`
  writeFileSync(join(root, 'test/fizz/Probes.sol'), ['// probe: V.CAP', 'abstract contract ProbeCap {', fn('read_probeCap'), fn('property_probeCapLow'), '}',
    'abstract contract ProbeFee {', fn('read_probeFee'), '}', 'abstract contract ProbeLoose {', fn('read_probeLoose'), '}',
    'abstract contract ProbeGone {', fn('read_probeGone'), '}'].join('\n'))
  const spanned = (name: string, cites: string | null, start: number): Suite['probes'][number] => ({ ...row(name, cites, []), start, end: start + 2 })
  const said = { property_probeCap: 'true on 3 of 4 sequences', property_probeCapLow: 'true on 0 of 4 sequences',
    property_probeFee: 'dropped: no corpus', property_probeLoose: 'true on 4 of 4 sequences' }
  expect(held(root, [spanned('ProbeCap', 'V.CAP', 2), spanned('ProbeFee', 'V.FEE', 6), spanned('ProbeLoose', null, 9), spanned('ProbeGone', 'V.GONE', 12)], said))
    .toEqual({ 'V.CAP': 'property_probeCap true on 3 of 4 sequences; property_probeCapLow true on 0 of 4 sequences' })
})

test('targetContracts not naming one is refused before forge', () => {
  vi.mocked(spawnSync).mockClear()
  const missing = project(HARNESS, [])
  writeFileSync(join(missing.root, 'medusa.json'), '{}')
  expect(() => trackers(missing.root, missing.corpus)).toThrow(/fuzzing\.targetContracts/)
  const two = project(HARNESS, ['FuzzTester', 'Other'])
  expect(() => trackers(two.root, two.corpus)).toThrow(/fuzzing\.targetContracts/)
  expect(spawnSync).not.toHaveBeenCalled()
})

test('the harness deploys from medusa.json\'s deployer and balance', () => {
  const setUp = (fuzzing: object): [string[], string] => {
    const { root, corpus } = project(HARNESS, ['FuzzTester'], fuzzing)
    let text = ''
    faked((cwd) => { text = readFileSync(join(cwd, TEST), 'utf8'); return { status: 0, stdout: '', stderr: '' } })
    trackers(root, corpus)
    return [(/function setUp\(\) public \{ (.*) \}$/m.exec(text)?.[1] ?? '').split('; ').map((s) => s.replace(/;?$/, ';')),
      /^contract Deployer \{ function deploy\(\) external returns \(FuzzTester h\) \{ h = (.*); \} \}$/m.exec(text)?.[1] ?? '']
  }
  const deployed = (value: string): string[] => [`vm.deal(address(uint160(196608)), ${value});`, 'vm.etch(address(uint160(196608)), type(Deployer).runtimeCode);',
    'harness = Deployer(address(uint160(196608))).deploy();', 'vm.etch(address(uint160(196608)), "");']
  expect(setUp({ targetContractsBalances: ['0xd3c21bcecceda1000000'] }))
    .toEqual([deployed('1000000000000000000000000'), 'new FuzzTester{value: 1000000000000000000000000}()'])
  expect(setUp({})).toEqual([deployed('0'), 'new FuzzTester()'])
})

test('a balance that is not an integer throws before forge', () => {
  vi.mocked(spawnSync).mockClear()
  const { root, corpus } = project(HARNESS, ['FuzzTester'], { targetContractsBalances: ['lots'] })
  expect(() => trackers(root, corpus)).toThrow(SyntaxError)
  expect(spawnSync).not.toHaveBeenCalled()
})

test('460 sequences replay 50, each handler, under fuzz and wall', () => {
  const { root, corpus } = sequenced(400)
  const selectors = [1, 2, 3, 4, 5].map((n) => String(n).repeat(8))
  const call = (data: string): object => ({ call: { from: '0x10000', data: `0x${data}` } })
  for (let i = 0; i < 60; i++) writeFileSync(join(corpus, `call_sequences/immutable/long${String(i)}.json`), JSON.stringify([call('12345678'), call('12345678'), call(selectors[i % 5] ?? '')]))
  let text = ''
  faked((cwd) => { text = readFileSync(join(cwd, TEST), 'utf8'); return { status: 0, stdout: '', stderr: '' } })
  expect(trackers(root, corpus)).toEqual(new Map())
  expect([text.match(/function testSequence\d+\(\) public/g)?.length, text.includes('testReadings')]).toEqual([50, false])
  expect(selectors.filter((s) => text.includes(`hex"${s}"`))).toEqual(selectors)
  expect([text.match(/replay\(/g)?.length, /^ *[\w()]+\.(?:static)?call\(/m.test(text)]).toEqual([61, false])
  expect([text.includes('vm.startPrank(from);'), text.includes('vm.prank(')]).toEqual([true, false])
  expect(vi.mocked(spawnSync).mock.calls.map(([, , o]) => [o?.env?.FOUNDRY_PROFILE, o?.env?.FOUNDRY_CODE_SIZE_LIMIT, o?.timeout]))
    .toEqual([['fuzz', '4294967295', 600_000], ['fuzz', '4294967295', 600_000]])
})

test('a forge test past the wall clock names size and count', () => {
  const { root, corpus } = sequenced(500)
  let bytes = 0
  faked((cwd) => {
    bytes = statSync(join(cwd, TEST)).size
    mkdirSync(join(cwd, 'out/ProbeReadings.t.sol'))
    return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync forge ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }
  })
  const run = vi.fn(() => trackers(root, corpus))
  expect(run).toThrow()
  expect(run.mock.results).toEqual([{ type: 'throw', value: new Error(`forge test -vv --match-path ${TEST} passed the 600000 ms wall clock on ${TEST}: ${String(bytes)} bytes, 50 of 500 sequences`) }])
  expect([bytes > 0, existsSync(join(root, TEST)), existsSync(join(root, 'out/ProbeReadings.t.sol'))]).toEqual([true, false, false])
})

test('a failing forge names failing tests, without warning blocks', () => {
  const { root, corpus } = sequenced(1)
  const warning = ['Warning (9302): Return value of low-level calls not used.', `  --> ${TEST}:648:9:`, '   |', '648 |         address(harness).call(hex"12345678");', '']
  const failed = [...Array(45).keys()].map((i) => `[FAIL: revert: ${String(i)}] testSequence${String(i)}() (gas: 1)`)
  faked(() => ({ status: 1, stdout: [...warning, ...failed.flatMap((l) => [l, 'Logs:'])].join('\n'), stderr: 'Error: boom\n' }))
  expect(() => trackers(root, corpus)).toThrow(new Error(`forge test -vv --match-path ${TEST} exited 1: ${[...failed.slice(6), 'Error: boom'].join(' ⏎ ')}`))
  faked(() => ({ status: 1, stdout: ['Compiling 3 files', '', ...warning, 'Compiler run done'].join('\n'), stderr: '' }))
  expect(() => trackers(root, corpus)).toThrow(new Error(`forge test -vv --match-path ${TEST} exited 1: Compiling 3 files ⏎ Compiler run done`))
})

test('the coverage handoff names kept and dropped counts', () => {
  faked(() => ({ status: 0, stdout: '', stderr: '' }))
  const handoff = (count: number, text: string): string => {
    const { root, corpus } = sequenced(count)
    const file = join(corpus, '../handoff/coverage.md')
    mkdirSync(join(corpus, '../handoff'))
    writeFileSync(file, text)
    trackers(root, corpus)
    return readFileSync(file, 'utf8')
  }
  expect(handoff(460, 'phase: coverage\nreplayed: 1 kept, 0 dropped\n')).toBe('phase: coverage\nreplayed: 50 kept, 410 dropped\n')
  expect(handoff(3, 'phase: coverage\n')).toBe('phase: coverage\nreplayed: 3 kept, 0 dropped\n')
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('an uncompilable probe file throws the compiler\'s message', () => {
  const { root, corpus } = project('pragma solidity ^0.8.20;\ncontract FuzzTester { constructor(uint256) {} }\n')
  expect(() => trackers(root, corpus)).toThrow(/exited 1: .*Wrong argument count/)
  expect([existsSync(join(root, TEST)), existsSync(join(root, 'out/ProbeReadings.t.sol'))]).toEqual([false, false])
}, 300_000)

test.runIf(process.env.CF_BENCH_LIVE === '1')('D6: trackers keeps the largest maxTotal across sequences', () => {
  const { root, corpus } = project(HARNESS)
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, 'test/fizz/Probes.sol'))
  expect(compiled(root)).toEqual([])
  const ids = JSON.parse(spawnSync('forge', ['inspect', 'FuzzTester', 'methodIdentifiers', '--json'], { cwd: root, encoding: 'utf8' }).stdout) as Record<string, string>
  for (const n of [5n, 3n]) {
    const data = `0x${ids['seen(uint256)'] ?? ''}${n.toString(16).padStart(64, '0')}`
    writeFileSync(join(corpus, `call_sequences/immutable/${String(n)}.json`), JSON.stringify([{ call: { from: '0x10000', to: '0xa647ff3c36cfab592509e13860ab8c4f28781a66', data }, blockNumberDelay: 1, blockTimestampDelay: 1 }]))
  }
  expect(trackers(root, corpus)).toEqual(new Map([['ProbeCap.maxTotal', 5n]]))
  expect([existsSync(join(root, TEST)), existsSync(join(root, 'out/ProbeReadings.t.sol'))]).toEqual([false, false])
}, 300_000)

test.runIf(process.env.CF_BENCH_LIVE === '1')('a reverting replayed call still reads every tracker', () => {
  const { root, corpus } = project(HARNESS)
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, 'test/fizz/Probes.sol'))
  expect(compiled(root)).toEqual([])
  const ids = JSON.parse(spawnSync('forge', ['inspect', 'FuzzTester', 'methodIdentifiers', '--json'], { cwd: root, encoding: 'utf8' }).stdout) as Record<string, string>
  const call = (data: string): object => ({ call: { from: '0x10000', data: `0x${data}` } })
  const seen = (n: bigint): object => call(`${ids['seen(uint256)'] ?? ''}${n.toString(16).padStart(64, '0')}`)
  writeFileSync(join(corpus, 'call_sequences/immutable/0.json'), JSON.stringify([seen(5n)]))
  writeFileSync(join(corpus, 'call_sequences/immutable/1.json'), JSON.stringify([call(ids['stop()'] ?? ''), seen(7n)]))
  expect(trackers(root, corpus)).toEqual(new Map([['ProbeCap.maxTotal', 7n]]))
  expect([existsSync(join(root, TEST)), existsSync(join(root, 'out/ProbeReadings.t.sol'))]).toEqual([false, false])
}, 300_000)

test.runIf(process.env.CF_BENCH_LIVE === '1')('a Medusa-deployed payable harness reads every tracker', () => {
  const payable = HARNESS.replace('constructor() { setup(); }', 'constructor() payable { require(msg.sender == address(0x30000) && msg.value == 1e24); setup(); }')
  const { root, corpus } = project(payable, ['FuzzTester'], { targetContractsBalances: ['0xd3c21bcecceda1000000'] })
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, 'test/fizz/Probes.sol'))
  expect(compiled(root)).toEqual([])
  const ids = JSON.parse(spawnSync('forge', ['inspect', 'FuzzTester', 'methodIdentifiers', '--json'], { cwd: root, encoding: 'utf8' }).stdout) as Record<string, string>
  writeFileSync(join(corpus, 'call_sequences/immutable/0.json'), JSON.stringify([{ call: { from: '0x10000', data: `0x${ids['seen(uint256)'] ?? ''}${5n.toString(16).padStart(64, '0')}` } }]))
  expect(trackers(root, corpus)).toEqual(new Map([['ProbeCap.maxTotal', 5n]]))
}, 300_000)

test.runIf(process.env.CF_BENCH_LIVE === '1')('a harness that starts its own prank reads every tracker', () => {
  const pranked = HARNESS.replace('contract FuzzTester {', 'interface Vm { function startPrank(address sender) external; }\ncontract FuzzTester {')
    .replace('constructor() { setup(); }', 'constructor() { Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).startPrank(address(this)); setup(); }')
  const { root, corpus } = project(pranked)
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, 'test/fizz/Probes.sol'))
  expect(compiled(root)).toEqual([])
  const ids = JSON.parse(spawnSync('forge', ['inspect', 'FuzzTester', 'methodIdentifiers', '--json'], { cwd: root, encoding: 'utf8' }).stdout) as Record<string, string>
  writeFileSync(join(corpus, 'call_sequences/immutable/0.json'), JSON.stringify([{ call: { from: '0x10000', data: `0x${ids['seen(uint256)'] ?? ''}${5n.toString(16).padStart(64, '0')}` } }]))
  expect(trackers(root, corpus)).toEqual(new Map([['ProbeCap.maxTotal', 5n]]))
}, 300_000)

test.runIf(process.env.CF_BENCH_LIVE === '1')('a harness whose constructor calls vm.prank reads every tracker', () => {
  const pranked = HARNESS.replace('contract FuzzTester {', 'interface Vm { function prank(address sender) external; }\ncontract FuzzTester {')
    .replace('constructor() { setup(); }', 'constructor() { require(msg.sender == address(0x30000)); Vm v = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);'
      + ' v.prank(address(1)); setup(); v.prank(address(2)); setup(); }')
  const { root, corpus } = project(pranked)
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Probes.sol'), join(root, 'test/fizz/Probes.sol'))
  expect(compiled(root)).toEqual([])
  const ids = JSON.parse(spawnSync('forge', ['inspect', 'FuzzTester', 'methodIdentifiers', '--json'], { cwd: root, encoding: 'utf8' }).stdout) as Record<string, string>
  writeFileSync(join(corpus, 'call_sequences/immutable/0.json'), JSON.stringify([{ call: { from: '0x10000', data: `0x${ids['seen(uint256)'] ?? ''}${5n.toString(16).padStart(64, '0')}` } }]))
  expect(trackers(root, corpus)).toEqual(new Map([['ProbeCap.maxTotal', 5n]]))
}, 300_000)
