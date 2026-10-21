import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')

test('D4: the manifest runs node and writes under ~/cf_work', () => {
  expect(seat(root, 'fetcher').manifest).toEqual({
    seat: 'fetcher', model: 'claude-opus-5-5', effort: 'medium', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash(node:*)'], write_paths: ['~/cf_work'],
  })
})

test('D4: the prompt opens with its name and closes on a run fence', () => {
  const prompt = seat(root, 'fetcher').prompt
  expect(prompt.startsWith('# fetcher\n')).toBe(true)
  for (const part of ['# Output', 'node', '- run:', 'commit:', '# HEAD']) expect(prompt).toContain(part)
})

test('D4: the digests hold', () => {
  expect(check(root, '2026-10-21')).toEqual([])
})
