import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
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
  writeFileSync(join(root, 'foundry.toml'), '[profile.default]\n')
  return { root, corpus }
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

test.runIf(process.env.CF_BENCH_LIVE === '1')('D5: a failing forge test throws stderr and leaves no file', () => {
  const { root, corpus } = project('pragma solidity ^0.8.20;\ncontract FuzzTester { constructor(uint256) {} }\n')
  expect(() => trackers(root, corpus)).toThrow(/^forge test -vv --match-path test\/fizz\/ProbeReadings\.t\.sol exited 1: \S/)
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
