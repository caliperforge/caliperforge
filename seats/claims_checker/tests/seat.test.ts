import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bare } from '../../../providers/kind.ts'
import { WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D5: the manifest holds Read and no write tool or path', () => {
  const card = seat(root, 'claims_checker').manifest
  expect(card).toEqual({ seat: 'claims_checker', model: 'claude-opus-5-5', effort: 'high', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D5: the roster carries claims_checker, loaded as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'claims_checker')).toMatchObject({ kind: 'card', path: 'rules/roster/claims_checker.yaml' })
})

test('D5: the prompt names statements, evidence kinds and fence', () => {
  const prompt = seat(root, 'claims_checker').prompt
  for (const part of ['what we ran', 'a number', 'a version', 'maintainer or a standard said', 'Opinions, asks and plans',
    'a path to a log', '/commit/', '/actions/runs/', 'quote', 'none', 'claims:', 'evidence:']) expect(prompt).toContain(part)
})
