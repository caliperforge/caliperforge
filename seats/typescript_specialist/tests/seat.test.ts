import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest declares seat, model, effort, tools and write_paths', () => {
  expect(Seat.parse(seat(root, 'typescript_specialist').manifest)).toMatchObject({
    seat: 'typescript_specialist',
    effort: 'high',
    write_paths: ['src'],
  })
})

test('the roster carries the seat and the loader gives it a rules row', () => {
  const row = rules(root).find((r) => r.id === 'typescript_specialist')
  expect(row).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the prompt tells the seat to close with the handback fence', () => {
  expect(seat(root, 'typescript_specialist').prompt).toContain('- id: D1')
})

test('the prompt names the row a file outside the brief needs', () => {
  expect(seat(root, 'typescript_specialist').prompt).toContain('under `## Outside the files`')
})

test('the prompt says the brief\'s files are handed', () => {
  expect(seat(root, 'typescript_specialist').prompt).toContain('follow it under `# The files`')
})

test('the prompt names the only commands the seat may run', () => {
  expect(seat(root, 'typescript_specialist').prompt).toContain('Those npm scripts are the only commands you may run')
})
