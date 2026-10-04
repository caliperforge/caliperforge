import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { listed, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-10-04'

function copied(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-director-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  return tree
}

test('D1: the manifest is coo_lite with the seat renamed', () => {
  expect(seat(root, 'director').manifest).toEqual({
    seat: 'director', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Bash(cf look:*)'], write_paths: [],
  })
})

test('D2: the prompt is coo_lite with its heading renamed', () => {
  const coo = seat(root, 'coo_lite').prompt
  expect(seat(root, 'director').prompt).toBe(coo.replace(/^# coo_lite\n/, '# director\n'))
})

test('D3: coo_lite still loads and director follows it', () => {
  expect(seat(root, 'coo_lite').manifest.seat).toBe('coo_lite')
  const seats = listed(root).seats
  expect(seats[seats.indexOf('coo_lite') + 1]).toBe('director')
})

test('D4: the digests hold and director is a card row', () => {
  expect(check(root, TODAY)).toEqual([])
  expect(rules(root).find((r) => r.id === 'director')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D5: a drifted director prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/director/prompt.md'), '\n')
  expect(() => seat(tree, 'director')).toThrow(/prompt does not match its digest/)
})

test('D6: a roster without the director digests is stale', () => {
  const tree = copied()
  const roster = join(tree, 'rules/roster.yaml')
  writeFileSync(roster, readFileSync(roster, 'utf8').replace(/ {2}director:\n(?: {4}.*\n){2}/, ''))
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster.yaml')
})

test('D7: coo_lite decides by default and names ask_coo', () => {
  const prompt = seat(root, 'coo_lite').prompt
  expect(prompt).toContain('## Decide by default')
  for (const n of [1, 2, 3, 4]) expect(prompt).toContain(`(${String(n)})`)
  expect(prompt).toContain('move: <rule | waive | return | fix | close | file | ask_ceo | ask_coo>')
})
