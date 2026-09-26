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

const deleted = 'diff --git a/t/a.test.ts b/t/a.test.ts\ndeleted file mode 100644\n--- a/t/a.test.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-test(\'parses\', () => {\n-  expect(parse(F)).toBe(1)\n-})\n'
const block = '-test(\'parses\', () => {\n-  expect(parse(F)).toBe(1)\n-})\n'
const header = '--- a/t/b.test.ts\n+++ b/t/b.test.ts\n@@ -1,6 +1,3 @@\n test(\'stays\', () => {\n'
const dropped = `${header}   expect(keep()).toBe(1)\n })\n${block}`

test('refuses the deletion of a whole test file while the suite is green', () => {
  const verdict = weakened(deleted, 'green')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['t/a.test.ts:1 test.weakened.removed'])
})

test('passes the deletion of a test file whose path is named', () => {
  const verdict = weakened(deleted, 'green', 'drop t/a.test.ts: covered by t/b.test.ts')
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('passes a removed test block whose title is named', () => {
  expect(weakened(dropped, 'green', 'remove parses').outcome).toBe('pass')
})

test('refuses a removed test block when named names another test', () => {
  expect(weakened(dropped, 'green', 'remove other').spans).toEqual(['t/b.test.ts:4 test.weakened.removed'])
})

test('refuses an assertion removed from a test that stays beside a named removal', () => {
  const verdict = weakened(`${header}-  expect(keep()).toBe(1)\n })\n${block}`, 'green', 'remove parses')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['t/b.test.ts:2 test.weakened.removed'])
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
