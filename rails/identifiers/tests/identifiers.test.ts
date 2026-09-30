import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { identifiers } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses a missing file, a line past its end, an absent ADR', () => {
  const verdict = identifiers(root, fixture('red.text.md'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('identifiers')
  expect(verdict.spans).toEqual([
    'text:3 identifier.unresolved',
    'text:3 identifier.unresolved',
    'text:4 identifier.unresolved',
  ])
  expect(verdict.message).toContain('rails/fact-light/index.ts, rails/diff.ts:900, ADR 0009')
})

test('passes a text whose every identifier resolves in the tree', () => {
  const verdict = identifiers(root, fixture('green.text.md'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('ignores a name whose first segment is not a tree directory', () => {
  expect(identifiers(root, 'merged upstream-org/project and https://github.com/o/r/pull/3').spans).toEqual([])
})

test('reads a plus as part of a file name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ids-'))
  mkdirSync(join(dir, 'Atelier'))
  writeFileSync(join(dir, 'Atelier', 'Source+Runs.swift'), '')
  expect(identifiers(dir, 'the query lives in Atelier/Source+Runs.swift').outcome).toBe('pass')
  expect(identifiers(dir, 'see Atelier/Source+Seats.swift').message).toContain('Atelier/Source+Seats.swift')
})

const deletion = '--- a/Atelier/X.swift\n+++ /dev/null\n@@ -1 +0,0 @@\n-struct X {}\n'

function atelier(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-ids-'))
  mkdirSync(join(dir, 'Atelier'))
  return dir
}

test('passes a folder the diff deletes', () => {
  const verdict = identifiers(atelier(), 'removed Atelier/Gone/ and Atelier/Go', deletion.replace('Atelier/X', 'Atelier/Gone/X'))
  expect(verdict.message).toContain('name no source in the tree: Atelier/Go')
  expect(verdict.spans).toHaveLength(1)
})

test('passes a path the diff deletes', () => {
  const verdict = identifiers(atelier(), 'removed Atelier/X.swift', deletion)
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses a path neither on disk nor deleted', () => {
  const verdict = identifiers(atelier(), 'see Atelier/Y.swift', deletion)
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.message).toContain('Atelier/Y.swift')
})

test('a path ending a sentence keeps its full stop out of the name', () => {
  expect(identifiers(root, 'the gate lives in rails/diff.ts.').outcome).toBe('pass')
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, identifiers(root, fixture('red.text.md')), 0.01)
  const row = db.prepare('SELECT gate, step, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', step: 3, kind: 'rail', outcome: 'refuse', rail_id: 'identifiers', origin_kind: 'rail', origin_ref: 'identifiers' })
})
