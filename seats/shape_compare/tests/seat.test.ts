import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-11-02'
const ROW = '- drift: <method or type> | <lang>: <shape> | <lang>: <shape> | kind: <sync-async|missing|extra|error-model|naming|types> | files: <path:line>, <path:line>'
const KINDS = ['`sync-async`', '`missing`', '`extra`', '`error-model`', '`naming`', '`types`']

test('D1: the manifest is Sonnet with no tools and no write path', () => {
  expect(seat(root, 'shape_compare').manifest).toEqual({ seat: 'shape_compare', model: 'claude-sonnet-5', effort: 'medium', tools: [], write_paths: [] })
})

test('D2: the roster carries shape_compare as a rules row', () => {
  expect(rules(root)).toContainEqual(expect.objectContaining({ id: 'shape_compare', kind: 'card', path: 'rules/roster/shape_compare.yaml' }))
})

test('D3: the prompt holds the drift row, its six kinds and none', () => {
  const prompt = seat(root, 'shape_compare').prompt
  for (const part of [ROW, ...KINDS, '`none`']) expect(prompt).toContain(part)
})

test('D4: a write tool with no write paths is still refused', () => {
  const manifest = seat(root, 'shape_compare').manifest
  expect(() => Seat.parse({ ...manifest, tools: ['Write'] })).toThrow(/save Bash\(cf look:\*\)/)
})

test('D5: the digests hold', () => {
  expect(check(root, TODAY)).toEqual([])
})
