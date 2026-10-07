import { join } from 'node:path'
import { expect, test } from 'vitest'
import { packs } from '../../../reviews/packs.ts'
import { Seat, rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('the manifest declares seat, model, effort, tools and paths', () => {
  expect(Seat.parse(seat(root, 'typescript_specialist').manifest)).toMatchObject({
    seat: 'typescript_specialist',
    effort: 'high',
    write_paths: ['brief:files'],
  })
})

test('the roster carries the seat and it loads as a rules row', () => {
  const row = rules(root).find((r) => r.id === 'typescript_specialist')
  expect(row).toMatchObject({ kind: 'card', path: 'rules/roster/typescript_specialist.yaml' })
})

test('the prompt tells the seat to close with the handback fence', () => {
  expect(seat(root, 'typescript_specialist', 'build').prompt).toContain('- id: D1')
})

test('D2: the build mode, not the prompt, holds the framing', () => {
  const { prompt } = seat(root, 'typescript_specialist')
  for (const text of ['You build', '- id: D1', 'A file the ask needs removed goes under `## Deleted`']) {
    expect(prompt).not.toContain(text)
  }
  const build = seat(root, 'typescript_specialist', 'build').prompt
  expect(build).toContain('You build against the brief below. One checkout, one step.')
  expect(build).toContain('- id: D1')
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

test('the prompt says every command runs in the foreground', () => {
  expect(seat(root, 'typescript_specialist').prompt).toContain(
    'Every command runs in the foreground; wait for it to finish, and answer only after it has.',
  )
})

test('the prompt runs the ratchet test and names its budgets', () => {
  const { prompt } = seat(root, 'typescript_specialist')
  for (const text of ['checks/ratchet.test.ts', '60 characters', '300 for a new file']) expect(prompt).toContain(text)
})

test('a rebuild lists every case, carrying untouched rows forward', () => {
  expect(seat(root, 'typescript_specialist', 'build').prompt).toContain(
    "A rebuild's fence lists every case again: carry forward the rows the refusal did not touch, update the ones it did.",
  )
})

test('the prompt carries the own-repo and outside comment rules', () => {
  const { prompt } = seat(root, 'typescript_specialist')
  for (const line of [
    'On our own repository:',
    '- A comment states, in one sentence, a fact the code cannot say.',
    '- Why a change was made goes in the commit message, never in a comment.',
    '- Code the change replaces is deleted in the same job.',
    '- A fallback records that it fell back.',
    '- New logic goes in a new file rather than growing a file past its budget.',
    "On anyone else's repository, match its comment density instead.",
  ]) expect(prompt).toContain(line)
})

test('D1: What to check opens the prompt with TypeScript checks', () => {
  const { prompt } = seat(root, 'typescript_specialist')
  expect(prompt.startsWith('# typescript_specialist\n\n## What to check\n')).toBe(true)
  const checks = prompt.slice(0, prompt.indexOf('## Profile'))
  for (const word of ['caller', 'import', 'Date.parse', 'second = 60', 'description', 'result: {}']) expect(checks).toContain(word)
})

test('D2: review mode reads What to check before the profile', () => {
  const p = 'cli/x.ts'
  const out = packs(root, `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`, null)
  const at = out.indexOf('## What to check')
  expect(at).toBeGreaterThan(-1)
  expect(at).toBeLessThan(out.indexOf('## Profile'))
  expect(out).not.toContain('- id: D1')
})
