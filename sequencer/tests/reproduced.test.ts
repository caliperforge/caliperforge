import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { shape, type Refused } from '../brief.ts'

const repo = join(import.meta.dirname, '../..')

const fixture = (name: string): string => readFileSync(join(repo, 'seats/brief_writer/tests', name), 'utf8')

const ask = fixture('ask.md')

const brief = fixture('brief.md')

const carrying = (rows: string[], text = brief): string =>
  text.replace('\n## Cases', `\n## Reproduced\n\n${rows.join('\n')}\n\n## Cases`)

const outside = (text: string): Refused | null => shape(text, ask, repo, true)

const TS = '- command: `npm run test -- sequencer/tests/brief.test.ts`'

test('D1 no ## Reproduced, or no single command row, is refused', () => {
  expect(outside(brief)).toMatchObject({ span: '## Reproduced' })
  expect(outside(carrying(['- expect: fails']))).toMatchObject({ span: '## Reproduced', reason: expect.stringContaining('command') as string })
  expect(outside(carrying([TS, '- command: `npm run lint`', '- expect: fails']))).toMatchObject({ span: '## Reproduced' })
})

test('D2 no single fails or shows expect row is refused', () => {
  const refused = { span: '## Reproduced', reason: expect.stringContaining('expect') as string }
  expect(outside(carrying([TS]))).toMatchObject(refused)
  expect(outside(carrying([TS, '- expect: maybe']))).toMatchObject(refused)
  expect(outside(carrying([TS, '- expect: fails', '- expect: shows']))).toMatchObject(refused)
})

test('D3 a command no builder admits is the span, naming seats', () => {
  expect(outside(carrying(['- command: `npx vitest run`', '- expect: fails'])))
    .toEqual({ span: 'npx vitest run', reason: 'npx vitest run is on the Bash(...) list of none of typescript_specialist' })
  expect(outside(carrying(['- command: `npm run test; rm x`', '- expect: shows'])))
    .toMatchObject({ span: 'npm run test; rm x', reason: expect.stringContaining('typescript_specialist') as string })
})

test('D3 a docs-only brief falls to outside_specialist, refused', () => {
  const docs = brief.replace(/## Files\n\n[^#]*/, '## Files\n\n- seats/brief_writer/prompt.md\n\n')
  expect(outside(carrying(['- command: `npm run test`', '- expect: fails'], docs)))
    .toMatchObject({ span: 'npm run test', reason: expect.stringContaining('outside_specialist') as string })
})

test('D4 a command the files\' builder admits passes', () => {
  expect(outside(carrying([TS, '- expect: fails', '- output: ignored']))).toBeNull()
  const kotlin = brief.replace(/## Files\n\n[^#]*/, '## Files\n\n- kotlin/build.gradle.kts (new)\n\n')
  expect(outside(carrying(['- command: `./gradlew test`', '- expect: shows'], kotlin))).toBeNull()
})

test('D5 a caliperforge brief passes with no ## Reproduced', () => {
  expect(shape(brief, ask, repo)).toBeNull()
})
