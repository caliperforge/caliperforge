import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { handoff } from '../../../templates/handoff.ts'
import { excerpts, LAYERS } from '../../../templates/map.ts'
import { phasesOf } from '../../../templates/phases.ts'
import { duplicated, packets, planned } from '../../../templates/plan.ts'
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
  expect(rules(plan([...GOOD, row('p3', { reads: 'ghost_total, ghost_missing' })]))).toEqual(['plan.tracker'])
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

test('D9: the new blocks add no handoff phase', () => {
  const blocks = [...readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8').matchAll(/^# Handoff: (.+)$/gm)].map((m) => m[1] ?? '')
  expect(blocks).toEqual(['context', 'scaffold', 'coverage', 'invariants', 'campaigns'])
  expect(phasesOf(skill)).toEqual(blocks.slice(0, 4))
  for (const phase of blocks) expect(handoff(skill, phase, '').map((r) => r.note).join('\n')).not.toMatch(/Candidates|Rows|Skipped/)
})
