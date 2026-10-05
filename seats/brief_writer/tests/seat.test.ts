import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Seat, rules, seat } from '../../../runner/rules.ts'
import { section, shape } from '../../../sequencer/brief.ts'

const root = join(import.meta.dirname, '../../..')

const servicesOnly = (brief: string): boolean => {
  const rows = /^## Tests\n\n((?:- .*\n)+)/m.exec(brief)?.[1]?.trimEnd().split('\n') ?? []
  return rows.length > 0 && rows.every((row) => /^- AtelierTests\/\w+(Service|Model)Tests\.swift /.test(row))
}

const card = { seat: 'brief_writer', model: 'claude-opus-5-5', effort: 'high', tools: ['Read', 'Glob', 'Grep'], write_paths: [] }

test('the manifest holds Read, Glob and Grep, and no write path', () => {
  expect(Seat.parse(seat(root, 'brief_writer').manifest)).toEqual(card)
})

test('a seat with no write path but a writing tool does not load', () => {
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Write'] }).success).toBe(false)
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Bash(git:*)'] }).success).toBe(false)
  expect(Seat.safeParse({ ...card, tools: ['Read', 'Write'], write_paths: ['src'] }).success).toBe(true)
})

test('the roster carries the seat and it loads as a rules row', () => {
  expect(rules(root).find((r) => r.id === 'brief_writer')).toMatchObject({ kind: 'card', path: 'rules/roster.yaml' })
})

test('the prompt names each shape part and both fences', () => {
  const prompt = seat(root, 'brief_writer').prompt
  for (const part of ['## Approach', '## Settled facts', '## Cases', '## Must not break', '## Files', '## Out of scope', 'outcome: unclear', 'outcome: split']) {
    expect(prompt).toContain(part)
  }
})

test('D4: each split part shows after, and when to name one', () => {
  const prompt = seat(root, 'brief_writer').prompt
  const fence = /outcome: split[\s\S]*?\n---/.exec(prompt)?.[0] ?? ''
  expect(fence.match(/^ {4}after: /gm)).toHaveLength(fence.match(/^ {2}- title: /gm)?.length ?? -1)
  expect(prompt.replace(/\s+/g, ' ')).toContain(
    'Name an earlier part in `after:` only when this part reads or changes code that part adds; parts that touch different files are `after: none`.',
  )
})

test('a reference\'s input rules go to Must not break', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When the ask mirrors, ports or matches another implementation, list that implementation\'s input rules under `## Must not break`: the values it accepts, what it does with an empty input, its bounds and the errors it raises, each with its file:line.',
  )
})

test('a generated file\'s row names the workflow step writing it', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When `## Files` lists a file a workflow generates, that row names the workflow step that writes it, meaning its `.github/workflows` file and the generator line before `git diff --exit-code`, and says step 3 runs that generator and diffs the file against its output.',
  )
})

test('the prompt says how to answer a last brief and question', () => {
  const prompt = seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('When the ask carries `# Your last brief`, the refusal under it names what to fix: fix that, keep every other line, and open only the files the fix needs.')
  expect(prompt).toContain('When the ask carries `# Your last question`, its answer is at the end of the ask: re-read only the files under `# Files you opened last time` marked changed, and what the answer adds.')
})

test('every builder of a changed type or signature is listed', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When the ask changes a shared type or a function\'s signature, search the checkout for its name and list every file that builds or implements it: under `## Files`, or under `## Tests` when it is a test or fixture.',
  )
})

test('D5: the Estimate line, and a brief too big splits', () => {
  const prompt = seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')
  expect(prompt).toContain('Under `## Approach`, write one line `Estimate: <n> lines`: the lines the change adds and removes, not counting tests or generated files.')
  expect(prompt).toContain('A brief past five files besides tests, on any repository, or on someone else\'s repository past that repository\'s size limit, is refused as more than one job: answer it with the split fence.')
})

test('D4: the writer counts files before it drafts', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'Before you draft, count the files the change touches besides tests, every file that builds or implements a changed type included; past five, answer with the split fence first.',
  )
})

test('the prompt states the brief check\'s path and length rules', () => {
  const prompt = seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')
  for (const rule of [
    'Every row under `## Files` and `## Tests` names one file, by its path from the checkout root: never a folder (`sequencer/tests/`), never an absolute path, never a path starting `../`.',
    'A file you read from the machine\'s own tree for context (an Atelier brief reading `schema/` or `cli/`) is not in the checkout: what you read there goes under `## Settled facts`, never under `## Files`.',
    '`(new)` marks only a path you looked for in the checkout and did not find.',
    'The brief is at most 100 lines: count them before you answer.',
    'A `## Files` row on a file over 300 lines names the block it changes as `path:start-end`.',
    '`# Files over 300 lines`, after the template, lists every file in the checkout that rule applies to, with its length: check each `## Files` row against it before you answer.',
  ]) expect(prompt).toContain(rule)
})

test('the prompt carries a word-for-word block under Approach', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    'When the ask calls a fenced block word for word, byte for byte or verbatim, carry that block under `## Approach` exactly as the ask writes it, fence lines included.',
  )
})

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, name), 'utf8')
const ask = fixture('verbatim-ask.md')
const block = '```yaml\nseat: brief_writer\neffort: high\n```'
const carrying = (copy: string): string => fixture('brief.md').replace('\n## Settled facts', `\n${copy}\n\n## Settled facts`)

test('shape refuses a brief that drops the word-for-word block', () => {
  expect(shape(fixture('brief.md'), ask, root)?.span).toBe('seat: brief_writer')
})

test('shape refuses the block with one byte changed', () => {
  expect(shape(carrying(block.replace('high', 'low')), ask, root)?.span).toBe('seat: brief_writer')
  expect(shape(carrying(block.replace('```yaml', '```')), ask, root)?.span).toBe('seat: brief_writer')
})

test('shape passes the block copied byte for byte', () => {
  expect(shape(carrying(block), ask, root)).toBeNull()
})

test('a block the ask does not call word for word is not demanded', () => {
  expect(shape(fixture('brief.md'), ask.replace('word for word', 'as below'), root)).toBeNull()
})

test('D2: an Atelier brief tests services, not the tree', () => {
  expect(seat(root, 'brief_writer').prompt.replace(/\s+/g, ' ')).toContain(
    '`## Tests` for an Atelier ticket names service and model tests, and names an accessibility-tree test only for a control.',
  )
})

test('D3: atelier.md tests only services and models', () => {
  const brief = readFileSync(join(import.meta.dirname, 'atelier.md'), 'utf8')
  expect(servicesOnly(brief)).toBe(true)
  expect(servicesOnly(brief.replace('AtelierTests/NowRowModelTests.swift', 'AtelierUITests/NowScreenUITests.swift'))).toBe(false)
})

const seams = (prompt: string): boolean => {
  const headings = prompt.split('\n').filter((l) => l.startsWith('## '))
  const rows = section(prompt, '## Seams').split('\n').filter((l) => l.trim() !== '')
  return headings.at(-1) === '## Seams' && rows.length >= 1 && rows.length <= 15
}

test('D1-D3: each language prompt ends with 1 to 15 Seams lines', () => {
  for (const language of ['typescript', 'swift', 'kotlin', 'python']) {
    expect(seams(readFileSync(join(root, `seats/${language}_specialist/prompt.md`), 'utf8'))).toBe(true)
  }
})

test('D4: no Seams, 16 lines, or a later heading fails', () => {
  const rows = (n: number): string => '- row\n'.repeat(n)
  expect(seams(`# s\n\n## Seams\n\n${rows(15)}`)).toBe(true)
  expect(seams(`# s\n\n## Profile\n\n${rows(1)}`)).toBe(false)
  expect(seams(`# s\n\n## Seams\n\n${rows(16)}`)).toBe(false)
  expect(seams(`# s\n\n## Seams\n\n${rows(1)}\n## After\n`)).toBe(false)
})
