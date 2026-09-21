import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

const card = { seat: 'brief_writer', model: 'claude-opus-5', effort: 'high', tools: ['Read', 'Glob', 'Grep'], write_paths: [] }

test('the manifest holds Read, Glob and Grep, and no write path', () => {
  expect(Seat.parse(seat(root, 'brief_writer').manifest)).toEqual(card)
})

test('a seat with no write path that holds a writing tool does not load', () => {
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Write'] }).success).toBe(false)
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Bash(git:*)'] }).success).toBe(false)
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Write'], write_paths: ['src'] }).success).toBe(true)
})

test('the roster carries the seat and the loader gives it a rules row', () => {
  expect(rules(root).find((r) => r.id === 'brief_writer')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the prompt names every part the shape check reads, and the unclear and split fences', () => {
  const prompt = seat(root, 'brief_writer').prompt
  for (const part of ['## Approach', '## Cases', '## Must not break', '## Files', '## Out of scope', 'outcome: unclear', 'outcome: split']) {
    expect(prompt).toContain(part)
  }
})
