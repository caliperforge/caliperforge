import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '../../..')
const skill = join(root, 'seats/fizz_lean_generator/skill')
const fizz = readFileSync(join(root, 'seats/fizz_generator/prompt.md'), 'utf8')
const file = readFileSync(join(skill, 'SKILL.md'), 'utf8')
const invariants = readFileSync(join(skill, 'phases/invariants.md'), 'utf8')
const templates = readFileSync(join(skill, 'phases/handoff/templates.md'), 'utf8')
const STEP_0 = '## Step 0: Print Banner'
const TITLE = '\n# Fizz\n\n'
const BUILD = '- A batch runs only the AST/syntax check on its own file, never {FUZZ_BUILD_CMD} or another full build: Step 9e\'s build is the machine\'s one compile after the last batch.'
const BATCH = [
  '- The batch leg runs Step 9d once per batch, each batch a fresh agent working only from the issue\'s `## Batch packet`: its SP rows, their map excerpts, the harness skeleton and the shared-helper rules.',
  '- A batch writes only test/fizz/PropertiesBatch<N>.sol, <N> being the batch number the issue names, declaring `contract PropertiesBatch<N>`; it edits no other suite file, PROPERTIES.md included, and writes its report to {PROJECT_ROOT}/{META_DIR}/reports/invariants-batch-<N>.md from the `# Batch` block.',
  BUILD,
]
const COMPILE = '- The machine compiles the suite once, after the collision check (handoff.ast).'
const MACHINE = [
  '- The machine writes the batch manifest after the last batch, one entry per test/fizz/PropertiesBatch<N>.sol, and makes FuzzTester inherit every PropertiesBatch<N> it lists.',
  '- The machine checks the batch manifest for a function declared in two batch files (plan.duplicate).',
  COMPILE,
]
const TEMPLATE = '# Batch\n\n## File\n\n- test/fizz/PropertiesBatch<N>.sol | contract: PropertiesBatch<N> | inherited by: FuzzTester | check: AST/syntax only, no full build\n\n## Implemented\n\n- <SP id> | function: <the property function it declares> | at: test/fizz/PropertiesBatch<N>.sol L<start>-L<end>\n\n# Handoff: context\n'

function at(heading: string): number {
  const i = fizz.indexOf(`\n${heading}`)
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

function line(pattern: RegExp): string {
  const found = pattern.exec(fizz)?.[0] ?? ''
  expect(found).not.toBe('')
  return found
}

const preamble = fizz.slice(fizz.indexOf(TITLE) + TITLE.length, at(STEP_0))

function stepless(text: string): void {
  expect(text).not.toMatch(/^#{2,3} Step /m)
  const [kept, held] = [new Set(preamble.split('\n')), new Set(text.split('\n'))]
  const copied = fizz.slice(at(STEP_0)).split('\n').filter((row) => row.length >= 40 && !kept.has(row) && held.has(row))
  expect(copied).toEqual([])
}

function copied(text: string): void {
  expect(text).toBe(`---\nname: fizz_lean\n${line(/^description: .*$/m)}\n---\n\n# Fizz lean\n\n${preamble.trimEnd()}\n`)
}

test('D1: SKILL.md is the preamble verbatim and nothing after', () => {
  copied(file)
})

test('D2: a Conductor appended after the preamble fails', () => {
  expect(() => { copied(`${file}\n## Conductor\n`) }).toThrow()
})

test('D4: no step heading or step line, and a Step 6 line fails', () => {
  stepless(file)
  expect(() => { stepless(`${file}${line(/^Modify the scaffolded core files.*$/m)}\n`) }).toThrow()
})

function batched(text: string): void {
  const [handover] = text.split('\n## Step 9: ')
  for (const row of BATCH) expect(handover).toContain(`\n${row}\n`)
}

function ruled(text: string): void {
  const rules = text.split('\n').filter((l) => l.startsWith('- The machine'))
  expect(rules[0]).toMatch(/^- The machine checks plan\.md after the first leg: /)
  expect(rules.slice(1)).toEqual(MACHINE)
}

test('the handover holds the batch leg; a full build fails', () => {
  batched(invariants)
  expect(() => { batched(invariants.replace(BUILD, '- A batch runs {FUZZ_BUILD_CMD} on its own file.')) }).toThrow()
})

test('machine lines are plan, manifest, collision, compile', () => {
  ruled(invariants)
  expect(() => { ruled(invariants.replace(`${COMPILE}\n`, '')) }).toThrow()
})

test('templates.md holds the Batch block before Handoff: context', () => {
  expect(templates.split(TEMPLATE)).toHaveLength(2)
})
