import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import { compiled } from '../../../templates/extract.ts'
import { readings, trackers } from '../../../templates/probes.ts'
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
  + '    function seen(uint256 t) external { cap.seen(t); }\n}\n'

function project(entry: string, targets = ['FuzzTester']): { root: string; corpus: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-probes-'))
  const corpus = join(root, 'test/fizz/fizz_data/corpus_medusa')
  for (const dir of [join(root, 'out'), join(root, 'src'), join(corpus, 'call_sequences/immutable')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'test/fizz/FuzzTester.sol'), entry)
  writeFileSync(join(root, 'medusa.json'), JSON.stringify({ fuzzing: { targetContracts: targets } }))
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

test('D3: a missing value stays 0n or false, max-only is a limit', () => {
  const rows = [...ROWS, row('ProbeLoose', null, ['maxLoose'])]
  expect(readings(rows, new Map([['ProbeConvert.minAssets', 4n], ['ProbeLoose.maxLoose', 9n]]))).toEqual({ limits: { 'V.CAP': { max: 0n } },
    conversions: { 'V.convertToAssets': { min: 4n, max: 0n, saw1Wei: false } } })
})

test('D4: ProbeCalls.lastAssets does not change the readings', () => {
  expect(readings(ROWS, new Map([...VALUES, ['ProbeCalls.lastAssets', 999n]]))).toEqual(readings(ROWS, new Map(VALUES)))
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
  expect(vi.mocked(spawnSync).mock.calls.map(([, , o]) => [o?.env?.FOUNDRY_PROFILE, o?.timeout])).toEqual([['fuzz', 600_000], ['fuzz', 600_000]])
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

test('a failing forge names its last 40 stdout lines then stderr', () => {
  const { root, corpus } = sequenced(1)
  const lines = [...Array(45).keys()].map((i) => `line ${String(i + 1)}`)
  faked(() => ({ status: 1, stdout: lines.join('\n\n'), stderr: 'boom\n' }))
  expect(() => trackers(root, corpus)).toThrow(new Error(`forge test -vv --match-path ${TEST} exited 1: ${[...lines.slice(5), 'boom'].join(' ⏎ ')}`))
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
