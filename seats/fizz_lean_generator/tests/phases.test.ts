import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '../../..')
const skill = join(root, 'seats/fizz_lean_generator/skill')
const fizz = readFileSync(join(root, 'seats/fizz_generator/prompt.md'), 'utf8')
const STEP_5 = '## Step 5: Generate Scaffold'
const STEP_8 = '## Step 8: Reach Coverage With Medusa'
const PHASES: [string, string, string | null][] = [
  ['context', '## Step 0: Print Banner', STEP_5],
  ['scaffold', STEP_5, STEP_8],
  ['coverage', STEP_8, '## Step 9: Generate Invariants'],
  ['invariants', '## Step 9: Generate Invariants', '## Step 10: Run Campaigns'],
  ['campaigns', '## Step 10: Run Campaigns', null],
]
const READ = '- Before the first step, read the handoff named by `Start from` and only the files its `## Reads` lists. {MODE}, {AGENT_MODEL} and {FUZZ_BUILD_CMD} are the values {PROJECT_ROOT}/{META_DIR}/context.md records.'
const CLAMPED = '- In Step 7, for each state-changing entry point a property or a Step 3 candidate invariant targets, write a <contract>_<function>_clamped handler beside the raw one that bounds each argument to values the call accepts.'
const FILL = '- Fill your handoff\'s fact sections (## Signatures, ## Guards, ## Roles, ## Limits) with what the next phase needs, each row naming the file and line range you read it at, or - none when there is nothing to carry.'
const FROM = '- Work from that handoff\'s fact sections before opening code: open a source file only at a line range they name, or for a fact they do not hold.'
const SUB = '- Give each sub-agent you spawn the path of the handoff named by Start from and, in place of whole source files, only the ## Signatures line ranges of the contracts it works on.'
const READS = ', with {PROJECT_ROOT}/{META_DIR}/context.md and each file the next phase needs under `## Reads`'
const written = (name: string): string =>
  `- Before you end, write {META_DIR}/handoff/${name}.md, the path the issue names, from its \`# Handoff: ${name}\` block${name === 'campaigns' ? '' : READS}.`

function at(heading: string): number {
  const i = fizz.indexOf(`\n${heading}`)
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

const range = (start: string, end: string | null): string => fizz.slice(at(start), end === null ? undefined : at(end))
const phase = (name: string): string => readFileSync(join(skill, 'phases', `${name}.md`), 'utf8')
const steps = (text: string): string[] => text.match(/^#{2,3} Step .*$/gm) ?? []

function verbatim(file: string, block: string): void {
  expect(file.split(block)).toHaveLength(2)
}

function own(file: string, block: string): void {
  expect(steps(file)).toEqual(steps(block))
}

function handover(name: string, file: string, block: string): void {
  const [head, tail] = file.split(block)
  expect(tail).toBe('')
  expect(head).toMatch(new RegExp(`^# Fizz lean: ${name} \\(Steps [\\d.]+-[\\d.]+\\)\\n\\n## Handover\\n(?:(?!#).*\\n)*$`))
  for (const named of ['{META_DIR}/context.md', '{META_DIR}/reports/', '300 words', '~/.claude/skills/fizz']) expect(head).toContain(named)
  expect(head).toContain(written(name))
  if (name !== 'context') expect(head).toContain(READ)
  if (name === 'scaffold') expect(head).toContain(CLAMPED)
  if (name !== 'campaigns') expect(head).toContain(FILL)
  expect(head?.includes(FROM)).toBe(!['context', 'campaigns'].includes(name))
  expect(head?.includes(SUB)).toBe(name === 'invariants')
  expect(head).not.toMatch(/\bread\b[^\n]*\{META_DIR\}\/reports\//)
}

test.each(PHASES)('D1-D3: %s.md is a handover then its steps verbatim', (name, start, end) => {
  const [file, block] = [phase(name), range(start, end)]
  verbatim(file, block)
  own(file, block)
  handover(name, file, block)
})

test('D4: an edited Step 6 or an appended Step 8 fails', () => {
  const [file, block] = [phase('scaffold'), range(STEP_5, STEP_8)]
  const edited = file.replace('Modify the scaffolded core files', 'Edit the scaffolded core files')
  expect(edited).not.toBe(file)
  expect(() => { verbatim(edited, block) }).toThrow()
  expect(() => { own(`${file}${STEP_8}\n`, block) }).toThrow()
})

test('D2-D3: a reports read or a dropped clamped line fails', () => {
  const [file, block] = [phase('scaffold'), range(STEP_5, STEP_8)]
  const reports = `${READ}\n- Before the first step, read every report under {PROJECT_ROOT}/{META_DIR}/reports/.`
  expect(() => { handover('scaffold', file.replace(READ, reports), block) }).toThrow()
  expect(() => { handover('scaffold', file.replace(`${CLAMPED}\n`, ''), block) }).toThrow()
})

test.each([{ name: 'SUB', line: SUB }, { name: 'FILL', line: FILL }, { name: 'FROM', line: FROM }])('D5: invariants without $name fails', ({ line }) => {
  const [file, block] = [phase('invariants'), range('## Step 9: Generate Invariants', '## Step 10: Run Campaigns')]
  expect(() => { handover('invariants', file.replace(`${line}\n`, ''), block) }).toThrow()
})

test('D5: the lean skill holds no copied fizz folders', () => {
  for (const dir of ['references', 'agents', 'scripts', 'templates']) expect(existsSync(join(skill, dir))).toBe(false)
})
