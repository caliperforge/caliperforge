import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
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

test('D2: the roster carries growth_lead, loaded as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'growth_lead')).toMatchObject({ kind: 'card', path: 'rules/roster/growth_lead.yaml' })
})

test('D3 and D4: the Notes and their bounds, partners and fence', () => {
  const prompt = seat(root, 'growth_lead').prompt
  for (const part of ['14', '31', '60', 'question', 'topic:', 'notes:', 'replies:', 'partners:', 'swap', 'guest post', 'outreach']) expect(prompt).toContain(part)
})

test('D5: a roster without digests or a card with Bash fails', () => {
  const tree = mkdtempSync(join(tmpdir(), 'cf-growth-lead-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  writeFileSync(join(tree, 'rules/roster/growth_lead.yaml'), '')
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster/growth_lead.yaml')
  const card = seat(root, 'growth_lead').manifest
  expect(() => Seat.parse({ ...card, tools: [...card.tools, 'Bash'] })).toThrow()
})
