import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { bare } from '../../../providers/kind.ts'
import { Seat, WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-09-28'

test('D1: the manifest holds Read and no write tool or path', () => {
  const card = Seat.parse(seat(root, 'growth_lead').manifest)
  expect(card).toEqual({ seat: 'growth_lead', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries growth_lead and the loader gives it a rules row', () => {
  expect(rules(root).find((r) => r.id === 'growth_lead')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D3 and D4: the prompt names the Notes and their bounds, the partners and the fence', () => {
  const prompt = seat(root, 'growth_lead').prompt
  for (const part of ['14', '31', '60', 'question', 'topic:', 'notes:', 'replies:', 'partners:', 'swap', 'guest post', 'outreach']) expect(prompt).toContain(part)
})

test('D5: a roster without growth_lead digests fails the check, and a card with Bash does not parse', () => {
  const tree = mkdtempSync(join(tmpdir(), 'cf-growth-lead-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  const roster = join(tree, 'rules/roster.yaml')
  writeFileSync(roster, readFileSync(roster, 'utf8').replace(/ {2}growth_lead:\n(?: {4}.*\n){2}/, ''))
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster.yaml')
  const card = seat(root, 'growth_lead').manifest
  expect(() => Seat.parse({ ...card, tools: [...card.tools, 'Bash'] })).toThrow()
})
