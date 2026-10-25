import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { check } from '../../../cli/digests.ts'
import { rules, seat } from '../../../runner/rules.ts'

const root = join(import.meta.dirname, '../../..')
const TODAY = '2026-10-14'
const SHA = '92b0ea6786e6c210bc9a839e4813d50876c1c550'
const SKILL = 'fa706e94e9ec3456528985548f46461d44442d9223e26b2a0dbbb8b5f522172a'
const COMMANDS = new Set(['Bash(pwd)', 'Bash(forge:*)', 'Bash(FOUNDRY_PROFILE=fuzz forge:*)', 'Bash(medusa:*)', 'Bash(echidna:*)', 'Bash(node:*)',
  'Bash(bash:*)', 'Bash(rm -f /tmp/x-ray-attempts.md)'])
const TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent', ...COMMANDS]

function copied(): string {
  const tree = mkdtempSync(join(tmpdir(), 'cf-fizz-generator-'))
  for (const dir of ['rules', 'seats']) cpSync(join(root, dir), join(tree, dir), { recursive: true })
  cpSync(join(root, 'rules.seed.sql'), join(tree, 'rules.seed.sql'))
  return tree
}

function limited(tools: string[]): void {
  expect(tools.filter((t) => t === 'Bash' || (t.startsWith('Bash(') && !COMMANDS.has(t)))).toEqual([])
}

test('D1: the manifest loads past its digests', () => {
  expect(seat(root, 'fizz_generator').manifest).toEqual({
    seat: 'fizz_generator', model: 'claude-opus-5-5', effort: 'high', tools: TOOLS, reads: ['~/.claude/skills/fizz', '~/.claude/skills/x-ray'],
    write_paths: ['test/fizz', 'x-ray', 'medusa.json', 'PROPERTIES.md', 'echidna.yaml', 'foundry.toml'],
  })
})

test('D2: Bash is limited to pwd and the fizz tool commands', () => {
  const tools = seat(root, 'fizz_generator').manifest.tools
  expect(tools).toEqual(TOOLS)
  limited(tools)
})

test('D6: bare Bash or another command fails the D2 limit', () => {
  for (const extra of ['Bash', 'Bash(curl:*)', 'Bash(rm:*)', 'Bash(rm -rf /tmp/x-ray-attempts.md)']) expect(() => { limited([...TOOLS, extra]) }).toThrow()
})

test('D3: line 1 is the pinned sha and SKILL.md follows verbatim', () => {
  const [first, ...rest] = readFileSync(join(root, 'seats/fizz_generator/prompt.md'), 'utf8').split('\n')
  expect(first).toMatch(/^[0-9a-f]{40}$/)
  expect(first).toBe(SHA)
  expect(createHash('sha256').update(rest.join('\n')).digest('hex')).toBe(SKILL)
})

test('D4: the digests hold and fizz_generator is a card row', () => {
  expect(check(root, TODAY)).toEqual([])
  expect(rules(root)).toContainEqual(expect.objectContaining({
    id: 'fizz_generator', kind: 'card', path: 'rules/roster/fizz_generator.yaml',
  }))
})

test('D5: a drifted fizz_generator prompt is refused', () => {
  const tree = copied()
  appendFileSync(join(tree, 'seats/fizz_generator/prompt.md'), '\n')
  expect(() => seat(tree, 'fizz_generator')).toThrow(/prompt does not match its digest/)
})
