import { readFileSync } from 'node:fs'
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

test('refuses a path with no file, a line past the end of one, and an absent ADR', () => {
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

test('passes a text whose every identifier resolves against the tree', () => {
  const verdict = identifiers(root, fixture('green.text.md'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('leaves alone a name whose first segment is no directory of this tree', () => {
  expect(identifiers(root, 'merged upstream-org/project and https://github.com/o/r/pull/3').spans).toEqual([])
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, identifiers(root, fixture('red.text.md')), 0.01)
  const row = db.prepare('SELECT gate, step, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', step: 3, kind: 'rail', outcome: 'refuse', rail_id: 'identifiers', origin_kind: 'rail', origin_ref: 'identifiers' })
})
