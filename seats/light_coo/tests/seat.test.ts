import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { bare } from '../../../providers/kind.ts'
import { WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-09-28'

const copy = (): string => {
  const tree = mkdtempSync(join(tmpdir(), 'cf-light-coo-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  return tree
}

test('D1: the manifest reads with Read, Glob and Grep and holds no write tool or path', () => {
  const card = seat(root, 'light_coo').manifest
  expect(card).toEqual({ seat: 'light_coo', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read', 'Glob', 'Grep'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries light_coo, the loader gives it a rules row and the digests hold', () => {
  expect(rules(root).find((r) => r.id === 'light_coo')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
  expect(check(root, TODAY)).toEqual([])
})

test('D3: the prompt names the moves, the fence and every forced ask_ceo class', () => {
  const prompt = seat(root, 'light_coo').prompt
  for (const part of ['return', 'retry', 'ask_ceo', 'ticket', 'rulings:', 'plan:', 'ruling:', 'ceo_question:', '1,200']) expect(prompt).toContain(part)
  const prose = prompt.replace(/\s+/g, ' ')
  for (const forced of ['spend', 'posted outside our org', 'pacing of a target', "CEO's name", 'reversing a CEO ruling']) expect(prose).toContain(forced)
})

test('D4: a roster without the light_coo digests fails the check, and an unfilled prompt edit fails the load', () => {
  const stripped = copy()
  const roster = join(stripped, 'rules/roster.yaml')
  writeFileSync(roster, readFileSync(roster, 'utf8').replace(/ {2}light_coo:\n(?: {4}.*\n){2}/, ''))
  expect(check(stripped, TODAY).map((s) => s.path)).toContain('rules/roster.yaml')

  const edited = copy()
  appendFileSync(join(edited, 'seats/light_coo/prompt.md'), '\nedited\n')
  expect(() => seat(edited, 'light_coo')).toThrow('does not match its digest')
})
