import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-10-14'

function copied(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-account-lead-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  return tree
}

test('D1: the manifest is read-only with gh api and cf look', () => {
  expect(seat(root, 'account_lead').manifest).toEqual({
    seat: 'account_lead',
    model: 'claude-opus-5-5',
    effort: 'medium',
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash(gh api:*)', 'Bash(cf look:*)'],
    write_paths: [],
  })
})

test('D2: the prompt holds the five parts and Not found in order', () => {
  const prompt = seat(root, 'account_lead').prompt
  expect(prompt.startsWith('# account_lead\n')).toBe(true)
  const at = ['## Their world', '## Our work', '## Who brings us things', '## Openings', '## Ideas', '## Not found']
    .map((part) => prompt.indexOf(part))
  expect(at).not.toContain(-1)
  expect(at).toEqual([...at].sort((a, b) => a - b))
})

test('D3: the ideas fence comes before the sources fence', () => {
  const prompt = seat(root, 'account_lead').prompt
  for (const part of ['sources:', 'url:', 'fetched_at:', 'quote:', 'claim:', 'sources: []', '[source:n]']) {
    expect(prompt).toContain(part)
  }
  expect(prompt.indexOf('---\nideas:')).toBeGreaterThan(-1)
  expect(prompt.indexOf('---\nideas:')).toBeLessThan(prompt.lastIndexOf('---\nsources:'))
})

test('D4: the prompt refuses check-ins and sends nothing', () => {
  const prompt = seat(root, 'account_lead').prompt
  expect(prompt).toContain('never a check-in')
  expect(prompt).toContain('never sends, posts, comments or approves')
})

test('D5: the digests hold and account_lead is a card row', () => {
  expect(check(root, TODAY)).toEqual([])
  expect(rules(root).find((r) => r.id === 'account_lead')).toMatchObject({ kind: 'card', path: 'rules/roster/account_lead.yaml' })
})

test('D6: a card with Bash or Bash(gh:*) fails', () => {
  const card = seat(root, 'account_lead').manifest
  for (const tool of ['Bash', 'Bash(gh:*)']) expect(() => Seat.parse({ ...card, tools: [...card.tools, tool] })).toThrow()
})

test('D6: a roster without the account_lead digests is stale', () => {
  const tree = copied()
  writeFileSync(join(tree, 'rules/roster/account_lead.yaml'), '')
  expect(check(tree, TODAY).map((s) => s.path)).toContain('rules/roster/account_lead.yaml')
})

test('D6: a drifted account_lead prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/account_lead/prompt.md'), '\n')
  expect(() => seat(tree, 'account_lead')).toThrow(/prompt does not match its digest/)
})
