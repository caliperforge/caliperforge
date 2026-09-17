import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record } from '../../record.ts'
import { weakened } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses a green suite over removed, loosened and skipped assertions', () => {
  const verdict = weakened(fixture('red.diff'), 'green')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('test-weakened')
  expect(verdict.spans).toEqual([
    'src/tests/parse.test.ts:7 test.weakened.removed',
    'src/tests/parse.test.ts:7 test.weakened.loosened',
    'src/tests/parse.test.ts:10 test.weakened.skipped',
  ])
})

test('passes a diff that strengthens its assertions', () => {
  const verdict = weakened(fixture('green.diff'), 'green')
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('does not fire while the suite is red', () => {
  const verdict = weakened(fixture('red.diff'), 'red')
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toHaveLength(3)
})

test('ignores a weakened line outside a test file', () => {
  const diff = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,1 @@\n-expect(x).toBe(1)\n+expect(x).toBeDefined()\n'
  expect(weakened(diff, 'green').spans).toEqual([])
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, weakened(fixture('red.diff'), 'green'), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'test-weakened', origin_kind: 'rail', origin_ref: 'test-weakened' })
})
