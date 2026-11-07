import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { layered } from '../../../templates/handoff.ts'
import { sections } from '../../../templates/map.ts'
import { type Item, met, misread, type ProbeReadings, reach, unlocated, unmet, written } from '../../../templates/reach.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const REPORT = join(fixtures, 'reach_revert_report.json')
const MAP = [
  '## Signatures\n\n- V.deposit(uint256 assets) | at: src/V.sol L8-L11\n- V.withdraw(uint256 assets) | at: src/V.sol L13-L15\n'
  + '- V.convertToAssets(uint256 shares) returns (uint256) | at: src/V.sol L17-L19\n',
  '## Selected entry points\n\n- V.deposit(uint256 assets) | tier: primary\n- V.withdraw(uint256 assets) | tier: primary\n'
  + '- V.convertToAssets(uint256 shares) | tier: secondary\n',
  '## Guards\n\n- V.deposit | reverts: totalAssets + assets > CAP with "cap" | at: src/V.sol L9-L9\n'
  + '- V.withdraw | reverts: assets > totalAssets on underflow | at: src/V.sol L14-L14\n',
  '## Limits\n\n- V.CAP | bound: totalAssets at most 1e24 | at: src/V.sol L5-L5\n',
  '## Conversion points\n\n- V.convertToAssets | converts: shares to assets, rounding down at the division | at: src/V.sol L17-L19\n',
  '## Handlers\n\n- FuzzTester.v_deposit | target: V.deposit\n- FuzzTester.v_deposit_clamped | target: V.deposit\n- VHandler.v_withdraw | target: V.withdraw\n'
  + '- FuzzTester.v_convertToAssets | target: V.convertToAssets\n',
].join('\n')
const PROBES: ProbeReadings = { limits: { 'V.CAP': { max: 5n * 10n ** 23n } }, conversions: { 'V.convertToAssets': { min: 0n, max: 2n * 10n ** 24n, saw1Wei: false } } }
const WITHDRAW = 'Selected entry points V.withdraw(uint256 assets)'

function judged(probes = PROBES, report = REPORT, map = MAP, lcov = join(fixtures, 'lcov.info')): Item[] {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-reach-'))
  mkdirSync(join(root, 'src'))
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  return reach(root, map, lcov, report, probes)
}

const at = (items: Item[], key: string): Item | undefined => items.find((i) => i.key === key)
const keys = (items: Item[]): string[] => items.map((i) => i.key)
const unreachable = (map: string, rows: string[]): string => `${map}\n## Unreachable\n\n${rows.map((r) => `- ${r}\n`).join('')}`

test('D1: a guard seen only passing is not met', () => {
  expect(at(judged(), 'Guards V.deposit')).toMatchObject({ met: false, cells: ['passing: yes', 'reverting: no'], note: 'Guards V.deposit: reverting never seen' })
})

test('D2: a limit is met within 1% of its bound', () => {
  const limit = (limits: ProbeReadings['limits']): Item | undefined => at(judged({ ...PROBES, limits }), 'Limits V.CAP')
  expect(limit({ 'V.CAP': { max: 5n * 10n ** 23n } })?.met).toBe(false)
  expect(limit({ 'V.CAP': { max: 995n * 10n ** 21n } })?.met).toBe(true)
  expect(limit({})).toMatchObject({ met: false, note: 'Limits V.CAP: no probe reading' })
})

test('D3: a conversion missing its 1-wei case is not met', () => {
  expect(at(judged(), 'Conversion points V.convertToAssets')).toMatchObject({ met: false, note: 'Conversion points V.convertToAssets: no 1-wei case' })
})

test('D4: entry rows carry typed reverts, line and success %', () => {
  const report = join(mkdtempSync(join(tmpdir(), 'cf-fizz-reach-')), 'revert_report.json')
  writeFileSync(report, readFileSync(REPORT, 'utf8').replace('{ "panic: arithmetic underflow/overflow": { "count": 28',
    '{ "paused": { "count": 3, "pct": 11 }, "panic: arithmetic underflow/overflow": { "count": 25'))
  const items = judged(PROBES, report)
  expect(at(items, WITHDRAW)).toMatchObject({ met: true, cells: ['calls: 30', 'successes: 2', 'success: 7% (below 10)', 'lines: 33% (below 50)',
    'reverts: panic: arithmetic underflow/overflow [other] 25, paused [paused] 3'] })
  expect(at(items, 'Selected entry points V.deposit(uint256 assets)')?.cells).toEqual(['calls: 40', 'successes: 40', 'success: 100%', 'lines: 100%', 'reverts: none'])
  expect(keys(unmet(MAP, items))).not.toContain(WITHDRAW)
})

test('a guard reads passing from the next DA line', () => {
  const lcov = join(mkdtempSync(join(tmpdir(), 'cf-fizz-reach-')), 'lcov.info')
  writeFileSync(lcov, readFileSync(join(fixtures, 'lcov.info'), 'utf8').replace('DA:15,0\n', ''))
  expect(at(judged(PROBES, REPORT, MAP, lcov), 'Guards V.withdraw')).toMatchObject({ met: true, cells: ['passing: yes', 'reverting: yes'] })
})

test('handlers reading 0 calls on hit lines are reach.misread', () => {
  const report = join(mkdtempSync(join(tmpdir(), 'cf-fizz-reach-')), 'revert_report.json')
  writeFileSync(report, JSON.stringify({ contractRevertMetrics: { FuzzTester: { functionRevertMetrics: {} } } }))
  const items = judged(PROBES, report, MAP.replace('- FuzzTester.v_convertToAssets | target: V.convertToAssets\n', ''))
  const lost = ['Selected entry points V.deposit(uint256 assets)', WITHDRAW]
  expect(keys(items.filter((i) => i.misread))).toEqual(lost)
  expect(at(items, 'Selected entry points V.convertToAssets(uint256 shares)')).toMatchObject({ misread: false, cells: expect.arrayContaining(['lines: 100%']) as string[] })
  expect(misread(items)).toEqual([{ rule: 'reach.misread', note: `2 entry point(s) read 0 calls through ## Handlers on lines lcov.info hit: ${lost.join(', ')}` }])
  expect(misread(judged())).toEqual([])
})

test('an inherited entry point counts its parent file\'s lines', () => {
  const lcov = join(mkdtempSync(join(tmpdir(), 'cf-fizz-reach-')), 'lcov.info')
  writeFileSync(lcov, readFileSync(join(fixtures, 'lcov.info'), 'utf8').replace('src/V.sol', 'lib/V.sol'))
  const map = '## Signatures\n\n- C.deposit(uint256 assets) | at: lib/V.sol L8-L11\n\n## Selected entry points\n\n- C.deposit(uint256 assets) | tier: primary\n'
  expect(at(judged(PROBES, REPORT, map, lcov), 'Selected entry points C.deposit(uint256 assets)')?.cells).toContain('lines: 100%')
})

test('a row with no range is reach.unlocated, not a throw', () => {
  const map = MAP.replace('| tier: secondary\n', '| tier: secondary\n- V.transfer(address to) | tier: primary\n').replace('L14-L14\n', 'L14-L14\n- V.transfer | reverts: never\n')
  const items = judged(PROBES, REPORT, map)
  const lost = ['Selected entry points V.transfer(address to)', 'Guards V.transfer']
  expect(keys(items.filter((i) => !i.located))).toEqual(lost)
  expect(unlocated(items)).toEqual([{ rule: 'reach.unlocated', note: `2 row(s) have no at: <file> L<start>-L<end> in map.md: ${lost.join(', ')}` }])
  for (const key of lost) expect(keys(unmet(map, items))).not.toContain(key)
  expect(unlocated(judged())).toEqual([])
})

test('D5: unmet drops only a filled Unreachable reason', () => {
  const items = judged()
  expect(unmet(MAP, items).map(({ key, reverts }) => ({ key, reverts }))).toEqual([{ key: 'Guards V.deposit', reverts: [] },
    { key: 'Guards V.withdraw', reverts: ['panic: arithmetic underflow/overflow [other] 28'] }, { key: 'Limits V.CAP', reverts: [] },
    { key: 'Conversion points V.convertToAssets', reverts: [] }])
  expect(keys(unmet(unreachable(MAP, ['Guards V.deposit | reason: CAP needs 1e24 of deposits']), items))).not.toContain('Guards V.deposit')
  for (const reason of ['', '<why>']) expect(keys(unmet(unreachable(MAP, [`Guards V.deposit | reason: ${reason}`]), items))).toContain('Guards V.deposit')
  expect(met(MAP, items)).toMatchObject({ met: false, reasons: expect.arrayContaining(['Guards V.withdraw: passing never seen']) as string[] })
  expect(met(unreachable(MAP, unmet(MAP, items).map((i) => `${i.key} | reason: no input reaches it`)), items)).toEqual({ met: true, reasons: [] })
})

test('D6: coverage may change ## Unreachable, not ## Reach', () => {
  const map = written(MAP, judged())
  const reasoned = unreachable(map, ['Guards V.deposit | reason: CAP needs 1e24 of deposits'])
  expect(layered('coverage', map, written(map, []))).toEqual([{ rule: 'handoff.layer', note: 'coverage: ## Reach is the reach layer\'s and changed' }])
  expect(layered('coverage', map, reasoned)).toEqual([])
  expect(layered('invariants', map, reasoned)).toEqual([{ rule: 'handoff.layer', note: 'invariants: ## Unreachable is the coverage layer\'s and changed' }])
})

test('D7: written replaces ## Reach, keeps every other section', () => {
  const before = `${MAP}\n## Reach\n\n- stale | met: no\n\n${unreachable('', ['none']).trimStart()}`
  const after = written(before, judged())
  const others = (text: string): [string, string][] => sections(text).filter(([name]) => name !== 'Reach')
  expect(others(after)).toEqual(others(before))
  const reached = sections(after).find(([name]) => name === 'Reach')?.[1]
  expect(reached).toContain('- Guards V.deposit | met: no | passing: yes | reverting: no\n')
  expect(reached).not.toContain('stale')
})
