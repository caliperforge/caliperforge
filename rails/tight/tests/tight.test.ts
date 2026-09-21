import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { tight, type Subject } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

function subject(colour: string): Subject {
  return {
    diff: fixture(`${colour}.diff`),
    sources: { 'src/helper.ts': fixture(`${colour}.source.txt`) },
    description: fixture(`${colour}.description.md`),
  }
}

test('refuses the nine Tight breaches over a diff, naming every span', () => {
  const verdict = tight(root, subject('red'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('tight')
  expect(verdict.spans).toEqual([
    'src/helper.ts:2 tight.unused_import',
    'src/helper.ts:4 tight.justifying',
    'src/helper.ts:9 tight.restating',
    'src/helper.ts:10 tight.dead_helper',
    'src/helper.ts:14 tight.nesting',
    'description:1 tight.preamble',
    'description:3 tight.hedge',
    'description:3 tight.summary',
  ])
})

test('passes a diff and description that are Tight', () => {
  const verdict = tight(root, subject('green'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses a function longer than the manifest ceiling', () => {
  const body = [...Array(45).keys()].map((i) => `  const v${String(i)} = ${String(i)}`).join('\n')
  const source = `export function long(): number {\n${body}\n  return v0\n}\n`
  const diff = `--- /dev/null\n+++ b/src/long.ts\n@@ -0,0 +1,48 @@\n${source.split('\n').map((l) => `+${l}`).join('\n')}`
  const verdict = tight(root, { diff, sources: { 'src/long.ts': source }, description: 'Long.' })
  expect(verdict.spans).toEqual(['src/long.ts:1 tight.length'])
})

test('ignores a breach on a line the diff did not add', () => {
  const source = '// because it is old\nexport const x = 1\n'
  const diff = '--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1,2 +1,2 @@\n // because it is old\n-export const x = 0\n+export const x = 1\n'
  expect(tight(root, { diff, sources: { 'src/old.ts': source }, description: 'x.' }).outcome).toBe('pass')
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, tight(root, subject('red')), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'tight', origin_kind: 'rail', origin_ref: 'tight' })
})

const added = (path: string, source: string): string => {
  const lines = source.trimEnd().split('\n')
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
}

/** #105: plan 47 was refused on a template line that writes `// step ${i}`, read as a comment once an earlier `${…}` threw the scan off. */
test('text in a template or a regex is not a comment', () => {
  const template = [
    'export const body = (i: number): string => `    val step${String(i)} = ${String(i)}`',
    'export const doc = (i: number): string => `    // step ${String(i)}`',
    'export const stepString = 1',
  ].join('\n')
  const regex = 'export const slashes = (s: string): boolean => /\\/\\/ step string/.test(s)\nexport const stepString = 1'
  for (const source of [template, regex]) {
    const verdict = tight(root, { diff: added('src/fixture.ts', source), sources: { 'src/fixture.ts': source }, description: 'x.' })
    expect(verdict.spans).toEqual([])
  }
})

test('a restating comment after a template still refuses', () => {
  const source = 'export const doc = (i: number): string => `// step ${String(i)} done`\n// step count\nexport const stepCount = 1\n'
  const verdict = tight(root, { diff: added('src/fixture.ts', source), sources: { 'src/fixture.ts': source }, description: 'x.' })
  expect(verdict.spans).toEqual(['src/fixture.ts:2 tight.restating'])
})

test('a prose span is named for the text it read', () => {
  const verdict = tight(root, { ...subject('red'), prose: 'handback' })
  expect(verdict.spans.filter((s) => !s.startsWith('src/'))).toEqual(['handback:1 tight.preamble', 'handback:3 tight.hedge', 'handback:3 tight.summary'])
})
