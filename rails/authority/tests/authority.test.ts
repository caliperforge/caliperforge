import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { authority } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses a write outside write_paths and under a frozen migration', () => {
  const verdict = authority(root, 'typescript_specialist', fixture('red.diff'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('authority')
  expect(verdict.spans).toEqual(['schema/0001_init.sql:1 authority.frozen_schema', 'cli/cf.ts:1 authority.write_paths'])
})

test('passes a diff confined to the seat write_paths', () => {
  const verdict = authority(root, 'typescript_specialist', fixture('green.diff'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses an escape above the root', () => {
  const diff = '--- a/x\n+++ b/../outside.ts\n@@ -1,0 +1,1 @@\n+export const x = 1\n'
  expect(authority(root, 'typescript_specialist', diff).spans).toEqual(['../outside.ts:1 authority.write_paths'])
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, authority(root, 'typescript_specialist', fixture('red.diff')), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'authority', origin_kind: 'rail', origin_ref: 'authority' })
})
