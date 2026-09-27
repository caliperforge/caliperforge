import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { bare } from '../../../providers/kind.ts'
import { read } from '../../../reviews/verdict.ts'
import { WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-09-27'
const reply = (name: string): string => readFileSync(join(import.meta.dirname, name), 'utf8')

test('D1: the manifest holds Read and no write tool or path', () => {
  const card = seat(root, 'text_review').manifest
  expect(card).toEqual({ seat: 'text_review', model: 'claude-opus-5-5', effort: 'high', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries text_review and the loader gives it a rules row', () => {
  expect(rules(root).find((r) => r.id === 'text_review')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D3: an unsourced number reads as a claim.unverified refuse on its draft line', () => {
  const judged = read(reply('unsourced.reply.md'), 'draft')
  expect(judged).toMatchObject({ outcome: 'refuse', defect_class: 'claim.unverified' })
  expect(judged?.spans[0]).toMatch(/^draft\.md:/)
  expect(judged?.message).toContain('12')
})

test('D4: a wording note reads as a pass that carries the note in its message', () => {
  const judged = read(reply('wording.reply.md'), 'draft')
  expect(judged).toMatchObject({ outcome: 'pass', notes: [] })
  expect(judged?.message).toContain('"seamlessly" is an AI tell')
})

test('D5: the prompt names the inputs, the class and both fences', () => {
  const prompt = seat(root, 'text_review').prompt
  for (const part of ['claim.unverified', 'draft.md', 'packet.json', 'outcome: refuse', 'outcome: pass']) expect(prompt).toContain(part)
})

test('D6: the digests hold, and a roster that lists text_review without them fails the check', () => {
  expect(check(root, TODAY)).toEqual([])
  const tree = mkdtempSync(join(tmpdir(), 'cf-text-review-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  const roster = join(tree, 'rules/roster.yaml')
  writeFileSync(roster, readFileSync(roster, 'utf8').replace(/ {2}text_review:\n(?: {4}.*\n){2}/, ''))
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster.yaml')
})
