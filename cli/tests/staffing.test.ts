import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { staffingSection, unstaffed } from '../staffing.ts'

const root = join(import.meta.dirname, '../..')

function copy(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-unstaffed-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  return tree
}

test('a missing row is listed as an unstaffed cell', () => {
  const tree = copy()
  const table = join(tree, 'rules/staffing.yaml')
  writeFileSync(table, readFileSync(table, 'utf8').replace('- { template: pr_path, step: 4, key: lua, seat: lua_specialist }\n', ''))
  expect(staffingSection(unstaffed(tree))).toBe('unstaffed cells (1)\n  pr_path\tstep 4\tlua\n')
})

test('the checked-in table has no unstaffed cell', () => {
  expect(unstaffed(root)).toEqual([])
  expect(staffingSection(unstaffed(root))).toBe('unstaffed cells (0)\n  none\n')
})

test('a key named at one step is listed at every other step', () => {
  const tree = copy()
  appendFileSync(join(tree, 'rules/staffing.yaml'), '- { template: pr_path, step: 0, key: cobol, seat: typescript_specialist }\n')
  expect(unstaffed(tree)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((step) => ({ template: 'pr_path', step, key: 'cobol' })))
})

test('a seat with no seats/ folder throws', () => {
  const tree = copy()
  appendFileSync(join(tree, 'rules/staffing.yaml'), '- { template: pr_path, step: 0, key: cobol, seat: nobody }\n')
  expect(() => unstaffed(tree)).toThrow(/no seats\/nobody folder/)
})
