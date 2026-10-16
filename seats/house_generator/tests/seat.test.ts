import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-10-16'
const TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash(forge build:*)', 'Bash(forge test:*)', 'Bash(medusa fuzz:*)']
const COMMANDS = new Set(['Bash(forge build:*)', 'Bash(forge test:*)', 'Bash(medusa fuzz:*)'])

function copied(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-house-generator-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  return tree
}

function limited(tools: string[]): void {
  expect(tools.filter((t) => t === 'Bash' || (t.startsWith('Bash(') && !COMMANDS.has(t)))).toEqual([])
}

test('D1: the manifest loads past its digests', () => {
  expect(seat(root, 'house_generator').manifest).toEqual({
    seat: 'house_generator', model: 'claude-opus-5-5', effort: 'high', tools: TOOLS, write_paths: ['test/fizz'],
  })
})

test('Bash is limited to forge build, forge test, medusa fuzz', () => {
  limited(seat(root, 'house_generator').manifest.tools)
  for (const extra of ['Bash', 'Bash(forge:*)']) expect(() => { limited([...TOOLS, extra]) }).toThrow()
})

test('D4: the digests hold and house_generator is a card row', () => {
  expect(check(root, TODAY)).toEqual([])
  expect(rules(root)).toContainEqual(expect.objectContaining({
    id: 'house_generator', kind: 'card', path: 'rules/roster/house_generator.yaml',
  }))
})

test('D5: a drifted house_generator prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/house_generator/prompt.md'), '\n')
  expect(() => seat(tree, 'house_generator')).toThrow(/prompt does not match its digest/)
})

test('D6: the prompt opens with its own title, not a pinned sha', () => {
  const [first] = readFileSync(join(root, 'seats/house_generator/prompt.md'), 'utf8').split('\n')
  expect(first).toBe('# house_generator')
  expect(first).not.toMatch(/^[0-9a-f]{40}$/)
})
