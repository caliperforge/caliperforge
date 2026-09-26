import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

const card = { seat: 'brief_writer', model: 'claude-opus-5-5', effort: 'high', tools: ['Read', 'Glob', 'Grep'], write_paths: [] }

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
  for (const part of ['## Approach', '## Settled facts', '## Cases', '## Must not break', '## Files', '## Out of scope', 'outcome: unclear', 'outcome: split']) {
    expect(prompt).toContain(part)
  }
})

test('the prompt sends a reference implementation\'s input rules to Must not break', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When the ask mirrors, ports or matches another implementation, list that implementation\'s input rules under `## Must not break`: the values it accepts, what it does with an empty input, its bounds and the errors it raises, each with its file:line.',
  )
})

test('the prompt makes a generated file\'s row name the workflow step that writes it', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When `## Files` lists a file a workflow generates, that row names the workflow step that writes it, meaning its `.github/workflows` file and the generator line before `git diff --exit-code`, and says step 3 runs that generator and diffs the file against its output.',
  )
})

test('the prompt sends every builder and implementer of a changed shared type or signature to the file list', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When the ask changes a shared type or a function\'s signature, search the checkout for its name and list every file that builds or implements it: under `## Files`, or under `## Tests` when it is a test or fixture.',
  )
})
