import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { handoff } from '../../../templates/handoff.ts'
import { excerpts, LAYERS } from '../../../templates/map.ts'
import { phasesOf } from '../../../templates/phases.ts'
import { batches, collided, duplicated, inherits, packets, planned, unbatched } from '../../../templates/plan.ts'
import { slices } from '../../../templates/slices.ts'

const skill = join(import.meta.dirname, '../skill')
const V = readFileSync(join(import.meta.dirname, 'fixtures/V.sol'), 'utf8')
const CONTEXT = Object.entries({
  Roles: '- none',
  Guards: '- V.deposit | reverts: totalAssets + assets > CAP with "cap" | at: src/V.sol L9-L9',
  Limits: '- V.CAP | bound: totalAssets at most 1e24 | at: src/V.sol L5-L5',
  'Outside dependencies': '- none',
  'Conversion points': '- V.convertToAssets | converts: shares to assets, rounding down at the division | at: src/V.sol L17-L19',
  Aggregates: '- V.totalAssets | parts: deposits less withdrawals | movers: V.deposit, V.withdraw | at: src/V.sol L6-L6',
  'Not tracked': '- none',
}).map(([name, row]) => `## ${name}\n\n${row}\n`).join('\n')
const MACHINE = [
  '## Signatures\n\n- V.deposit(uint256 assets) | at: src/V.sol L8-L11\n- V.withdraw(uint256 assets) | at: src/V.sol L13-L15\n'
  + '- V.convertToAssets(uint256 shares) returns (uint256) | at: src/V.sol L17-L19\n',
  '## Selected entry points\n\n- V.deposit(uint256 assets) | tier: primary\n- V.withdraw(uint256 assets) | tier: primary\n'
  + '- V.convertToAssets(uint256 shares) | tier: secondary\n',
  '## Modifiers\n\n- none\n',
].join('\n')
const MAP = `${MACHINE}\n${CONTEXT}`
const LAYERED = '## Suite\n\n- handler_deposit | raw\n\n## Reach\n\n- V.deposit | reached\n'
const SUITE = ['ghost_total', 'handler_deposit']
const GUIDE = '## 6. Global properties\n\nGhosts first.\n'

const excerpt = (start: number, end: number): string => V.split('\n').slice(start - 1, end).join('\n')

function cut(): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-plan-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/V.sol'), V)
  excerpts(root, MAP, join(root, 'excerpts'))
  return join(root, 'excerpts')
}

function sliced(): string {
  const dir = join(cut(), '../slices')
  slices(MAP, join(dir, '../excerpts'), LAYERED, dir)
  return dir
}

const row = (id: string, cells: Record<string, string> = {}): string => `- ${id} | ${Object.entries({ says: 'assets add up', relies: '', reads: 'ghost_total',
  converted: 'no', tolerance: '', delta: '', fails: 'assets lost', implementer: 'global', ...cells }).map(([k, v]) => `${k}: ${v}`).join(' | ')}`
const plan = (rows: string[], skipped = ['- none']): string => `## Rows\n\n${rows.join('\n')}\n\n## Skipped\n\n${skipped.join('\n')}\n`
const GOOD = [row('p1', { relies: 'aggregates-1' }), row('p2', { relies: 'conversion-points-1', implementer: 'specific' })]
const rules = (text: string, unreached: string[] = []): string[] => planned(text, MAP, SUITE, unreached).refused.map((r) => r.rule)

test('D1: the conservation slice holds its index, rows and code', () => {
  const text = readFileSync(join(sliced(), 'conservation-auditor.md'), 'utf8')
  expect(text.split('\n\n## ')[0]).toBe(['## Index\n', '- signatures-1 V.deposit(uint256 assets)', '- signatures-2 V.withdraw(uint256 assets)',
    '- signatures-3 V.convertToAssets(uint256 shares) returns (uint256)', '- selected-entry-points-1 V.deposit(uint256 assets)',
    '- selected-entry-points-2 V.withdraw(uint256 assets)', '- selected-entry-points-3 V.convertToAssets(uint256 shares)', '- guards-1 V.deposit',
    '- limits-1 V.CAP', '- conversion-points-1 V.convertToAssets', '- aggregates-1 V.totalAssets'].join('\n'))
  expect(text).toContain(`## Aggregates\n\n- V.totalAssets | parts: deposits less withdrawals | movers: V.deposit, V.withdraw | at: src/V.sol L6-L6\n\`\`\`solidity\n${excerpt(6, 6)}\n\`\`\`\n`)
  expect(text).toContain(`- V.deposit(uint256 assets) | at: src/V.sol L8-L11\n\`\`\`solidity\n${excerpt(8, 11)}\n\`\`\`\n- V.withdraw(uint256 assets)`)
  for (const absent of ['- V.convertToAssets(', '## Guards', '## Limits', '## Conversion points']) expect(text).not.toContain(absent)
})

test('D2: the adversary sees all; every slice ends in layers', () => {
  const dir = sliced()
  const text = readFileSync(join(dir, 'adversarial-profit-maximizer.md'), 'utf8')
  for (const [, names] of LAYERS) for (const name of names) expect(text).toContain(`## ${name}\n`)
  const cuts = readdirSync(join(dir, '../excerpts'))
  expect(cuts).toHaveLength(7)
  for (const file of cuts) expect(text).toContain(readFileSync(join(dir, '../excerpts', file), 'utf8').trimEnd())
  expect(readdirSync(dir)).toHaveLength(5)
  for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), 'utf8').endsWith(LAYERED)).toBe(true)
})

test('D3: an aggregate no row relies on needs a skip reason', () => {
  expect(planned(plan(GOOD), MAP, SUITE, [])).toEqual({ refused: [], flagged: [] })
  const unused = [row('p2', { relies: 'conversion-points-1' })]
  expect(rules(plan(unused))).toEqual(['plan.unused'])
  expect(rules(plan(unused, ['- aggregates-1 | reason: p2 reads it through the price']))).toEqual([])
  expect(rules(plan(unused, ['- aggregates-1 | reason:']))).toEqual(['plan.unused'])
})

test('D4: reading a name the suite lacks is plan.tracker', () => {
  const read = plan([...GOOD, row('p3', { reads: 'ghost_total, handler_deposit, ghost_missing' })])
  expect(planned(read, MAP, ['ghost_total', 'H.handler_deposit'], []).refused).toEqual([
    { rule: 'plan.tracker', note: 'plan: p3 reads ghost_missing, which the suite does not hold' },
  ])
})

test('D5: converted needs a bound; implementer is one of two', () => {
  expect(rules(plan([...GOOD, row('p3', { converted: 'yes' })]))).toEqual(['plan.converted'])
  expect(rules(plan([...GOOD, row('p3', { converted: 'yes', delta: 'asset.balanceOf(vault)' })]))).toEqual([])
  expect(rules(plan([...GOOD, row('p3', { implementer: 'both' })]))).toEqual(['plan.implementer'])
})

test('D6: relying on an unreached entry point is flagged only', () => {
  expect(planned(plan([...GOOD, row('p3', { relies: 'signatures-1' })]), MAP, SUITE, ['V.deposit'])).toEqual({ refused: [], flagged: ['p3'] })
})

test('D7: each packet holds only its own rows and excerpts', () => {
  const { global, specific } = packets(plan(GOOD), MAP, cut(), GUIDE, SUITE)
  for (const held of [GOOD[0] ?? '', excerpt(6, 6), GUIDE, '- ghost_total\n- handler_deposit\n']) expect(global).toContain(held)
  for (const absent of ['- p2 ', excerpt(17, 19)]) expect(global).not.toContain(absent)
  for (const held of [GOOD[1] ?? '', excerpt(17, 19), GUIDE]) expect(specific).toContain(held)
  expect(specific).not.toContain(excerpt(6, 6))
})

test('D8: a function declared by both implementers is refused', () => {
  expect(duplicated('function ghost() {}\nfunction a() {}', 'function ghost() {}\nfunction b() {}'))
    .toEqual([{ rule: 'plan.duplicate', note: 'plan: function ghost is declared by both implementers' }])
  expect(duplicated('function a() {}', 'function b() {}')).toEqual([])
})

test('rows batch by contract, 10 to 15 each, a contract unsplit', () => {
  const map = `## Signatures\n\n${[...Array(12).keys()].map(String).map((c) => `- C${c}.f() | at: src/C${c}.sol L1-L1\n`).join('')}`
  const relying = (ids: string[]): string => plan(ids.map((id, i) => row(`p${String(i)}`, { relies: `signatures-${id}` })))
  const contracts = (packet: string): string[] => [...packet.matchAll(/relies: signatures-(\d+)/g)].map((m) => m[1] ?? '')
  const spread = batches(relying([...Array(60).keys()].map((i) => String((i % 12) + 1))), map, cut(), '', '').map(contracts)
  expect(spread.length).toBeGreaterThanOrEqual(5)
  expect(spread.length).toBeLessThanOrEqual(6)
  for (const ids of spread) expect(ids.length).toBeGreaterThanOrEqual(10)
  for (const ids of spread) expect(ids.length).toBeLessThanOrEqual(15)
  for (const id of new Set(spread.flat())) expect(spread.filter((ids) => ids.includes(id))).toHaveLength(1)
  const whole = batches(relying([...Array<string>(20).fill('1'), '2', '3', '2', '3']), map, cut(), '', '').map(contracts)
  expect(whole).toEqual([Array<string>(20).fill('1'), ['2', '2', '3', '3']])
})

test('a batch holds its rows, excerpts, skeleton and helpers only', () => {
  const own = [...Array(10).keys()].map((i) => row(`p${String(i)}`, { relies: 'aggregates-1' }))
  const handled = row('h', { relies: '', reads: 'handler_deposit' })
  const [first = '', second = '', ...rest] = batches(plan([...own, handled]), MAP, cut(), '## Skeleton\n', '## Helpers\n')
  expect(rest).toEqual([])
  for (const held of [...own, excerpt(6, 6), '## Skeleton\n\n## Helpers\n']) expect(first).toContain(held)
  expect(first).not.toContain('- h |')
  expect(second).toBe(`## Rows\n\n${handled}\n\n## Skeleton\n\n## Helpers\n`)
})

test('two batch files declaring the same function are refused', () => {
  const [a, b] = ['test/fizz/PropertiesBatch1.sol', 'test/fizz/PropertiesBatch2.sol']
  expect(collided({ [a]: 'function f() {}\nfunction g() {}', [b]: 'function f() {}' }))
    .toEqual([{ rule: 'plan.duplicate', note: `plan: function f is declared by ${a}, ${b}` }])
  expect(collided({ [a]: 'function f() {}', [b]: 'function g() {}' })).toEqual([])
  expect(collided({ [a]: 'function f() {}\nfunction f(uint256 x) {}', [b]: 'function g() {}' })).toEqual([])
})

test('a batch file with an open brace or no contract is refused', () => {
  const notes = (n: number, text: string): string[] => unbatched(n, text).map((r) => r.note)
  expect(notes(2, 'contract PropertiesBatch2 {\n  function f() public {} // }\n}\n')).toEqual([])
  expect(notes(2, 'contract PropertiesBatch2 {\n  function f() public {\n}\n')).toEqual(['batch 2: PropertiesBatch2.sol has an unclosed brace or comment'])
  expect(notes(2, 'contract PropertiesBatch1 {}\n')).toEqual(['batch 2: PropertiesBatch2.sol declares no contract PropertiesBatch2'])
  expect(unbatched(2, '').map((r) => r.rule)).toEqual(['batch.syntax', 'batch.syntax'])
})

test('FuzzTester imports and inherits each batch contract', () => {
  const batched = ['PropertiesBatch1', 'PropertiesBatch2']
  const listed = 'pragma solidity ^0.8.0;\nimport "./Properties.sol";\n\ncontract FuzzTester is Properties {}\n'
  const merged = 'pragma solidity ^0.8.0;\nimport "./Properties.sol";\nimport "./PropertiesBatch1.sol";\nimport "./PropertiesBatch2.sol";\n\n'
    + 'contract FuzzTester is Properties, PropertiesBatch1, PropertiesBatch2 {}\n'
  expect(inherits(listed, batched)).toBe(merged)
  expect(inherits(merged, batched)).toBe(merged)
  expect(inherits('pragma solidity ^0.8.0;\ncontract FuzzTester {}\n', ['PropertiesBatch1']))
    .toBe('pragma solidity ^0.8.0;\nimport "./PropertiesBatch1.sol";\ncontract FuzzTester is PropertiesBatch1 {}\n')
  expect(inherits('contract Other {}\n', batched)).toBeNull()
})

test('D9: the new blocks add no handoff phase', () => {
  const blocks = [...readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8').matchAll(/^# Handoff: (.+)$/gm)].map((m) => m[1] ?? '')
  expect(blocks).toEqual(['context', 'scaffold', 'coverage', 'invariants', 'campaigns'])
  expect(phasesOf(skill)).toEqual(blocks.slice(0, 4))
  for (const phase of blocks) expect(handoff(skill, phase, '').map((r) => r.note).join('\n')).not.toMatch(/Candidates|Rows|Skipped/)
})
