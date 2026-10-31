import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { verdictRows } from '../../../store/verdict.ts'
import { record } from '../../record.ts'
import { retired, weakened } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('refuses removed, loosened and skipped assertions when green', () => {
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

test('refuses deleting a whole test file while the suite is green', () => {
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

test('refuses a kept test\'s lost assertion beside a named removal', () => {
  const verdict = weakened(`${header}-  expect(keep()).toBe(1)\n })\n${block}`, 'green', 'remove parses')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['t/b.test.ts:2 test.weakened.removed'])
})

const loosened = `${header}+  expect(keep()).toBeNull()\n   expect(keep()).toBe(1)\n })\n${block}`

test('passes a loose assertion added beside a named removal', () => {
  const verdict = weakened(loosened, 'green', 'remove parses')
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses a loose assertion beside a removal named for another', () => {
  expect(weakened(loosened, 'green', 'remove other').spans).toEqual(['t/b.test.ts:2 test.weakened.loosened'])
})

const TITLES = ['one', 'two', 'three', 'four']
const retiring = (t: string): string => `-test('${t}', () => {\n-  const a = parse(F)\n \n-  expect(a).toBe(1)\n-})\n`
const shaped = `--- a/t/c.test.ts\n+++ b/t/c.test.ts\n@@ -1,20 +1,7 @@\n test('kept', () => {\n-  expect(two()).toBe(2)\n+  expect(two()).toBe(6)\n })\n${TITLES.map(retiring).join('')}`
const removal = (t: string): string => `- removed: ${t} | file: t/c.test.ts | why: retired by brief line 'drop ${t}'`
const listing = TITLES.map(removal).join('\n')

test('D1 passes a 1978-shaped diff whose every title is listed', () => {
  expect(weakened(shaped, 'green', TITLES.join(' ')).outcome).toBe('refuse')
  expect(weakened(shaped, 'green', '', listing)).toMatchObject({ outcome: 'pass', spans: [] })
})

test('D2 refuses as today with one title missing from the block', () => {
  const verdict = weakened(shaped, 'green', '', TITLES.slice(1).map(removal).join('\n'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['t/c.test.ts:2 test.weakened.removed'])
})

test('D3 refuses an added .skip with or without the block', () => {
  const skipped = shaped.replace(' })\n', ' })\n+test.skip(\'later\', () => {})\n')
  expect(weakened(skipped, 'green', '', listing).spans).toEqual(['t/c.test.ts:4 test.weakened.skipped'])
  expect(weakened(skipped, 'green').spans).toEqual(['t/c.test.ts:2 test.weakened.removed', 't/c.test.ts:4 test.weakened.skipped'])
})

test('D4 lines off the shape and a titleless file judge as today', () => {
  const off = ['- removed: one | file: t/c.test.ts', '- removed: one | file: t/c.test.ts | why: replaced by two'].join('\n')
  expect(retired(`${off}\nprose\n${removal('one')}\n`, removal('two'))).toBe(`${removal('one')}\n${removal('two')}`)
  expect(weakened(shaped, 'green', '', TITLES.map((t) => off.replaceAll('one', t)).join('\n')).spans).toEqual(['t/c.test.ts:2 test.weakened.removed'])
  const titleless = `${header}-  expect(keep()).toBe(1)\n })\n`
  const stays = '- removed: stays | file: t/b.test.ts | why: retired by brief line \'x\''
  expect(weakened(titleless, 'green', '', stays).spans).toEqual(['t/b.test.ts:2 test.weakened.removed'])
})

test('D5 the refuse names removed-tests.md and the line shape', () => {
  expect(weakened(shaped, 'green').message).toContain('removed-tests.md as `- removed: <exact test title> | file: <path> | why: replaced by \'<new title>\'`')
})

test('refuses a removed XCTAssert under a Swift Tests folder', () => {
  const diff = '--- a/swift/Tests/A/B.swift\n+++ b/swift/Tests/A/B.swift\n@@ -1,2 +1,1 @@\n func testB() {\n-  XCTAssertEqual(a, b)\n'
  expect(weakened(diff, 'green').spans).toEqual(['swift/Tests/A/B.swift:2 test.weakened.removed'])
})

test('refuses a t.Skip added to a Go test', () => {
  const diff = '--- a/x_test.go\n+++ b/x_test.go\n@@ -1,1 +1,2 @@\n func TestX(t *testing.T) {\n+\tt.Skip("flaky")\n'
  expect(weakened(diff, 'green').spans).toEqual(['x_test.go:2 test.weakened.skipped'])
})

test('refuses an assert_eq! removed from a Rust source file', () => {
  const diff = '--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,1 @@\n fn parses() {\n-    assert_eq!(parse("1"), 1);\n'
  const verdict = weakened(diff, 'green')
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['src/lib.rs:2 test.weakened.removed'])
})

const rust = (body: string) => `diff --git a/src/old.rs b/src/old.rs\ndeleted file mode 100644\n--- a/src/old.rs\n+++ /dev/null\n@@ -1,3 +0,0 @@\n${body}`

test('passes deleting a Rust file with no assertion in it', () => {
  expect(weakened(rust('-fn old() {\n-    1\n-}\n'), 'green').outcome).toBe('pass')
})

test('refuses deleting a Rust file that held an assert!', () => {
  expect(weakened(rust('-fn t() {\n-    assert!(ok());\n-}\n'), 'green').spans).toEqual(['src/old.rs:1 test.weakened.removed'])
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
  expect(verdictRows(db, plan)).toMatchObject([{ id, gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'test-weakened', origin_kind: 'rail', origin_ref: 'test-weakened' }])
})
