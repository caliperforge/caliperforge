import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bare } from '../../../providers/kind.ts'
import { Seat, WRITERS, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D1: the manifest holds Read and no write tool or path', () => {
  const card = Seat.parse(seat(root, 'writer').manifest)
  expect(card).toEqual({ seat: 'writer', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read'], write_paths: [] })
  expect(card.tools.filter((t) => WRITERS.has(bare(t)))).toEqual([])
})

test('D2: the roster carries the writer, loaded as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'writer')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('D5: the citations, the fence and each kind of post', () => {
  const prompt = seat(root, 'writer').prompt
  for (const part of ['[landed:', '[refusal:', 'learnings:', 'dest:', 'dek:', 'sources:', 'checks:', 'daily', 'ship', 'weekly', 'substack', 'note']) expect(prompt).toContain(part)
})
