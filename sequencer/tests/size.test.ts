import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { migrate, open, type Db } from '../../store/index.ts'
import { limitOf, sized } from '../size.ts'

const lines = (n: number): string[] => [...Array(n).keys()].map((i) => `x${String(i)}`)

const file = (path: string, added: string[]): string =>
  ['--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${String(added.length)} @@`, ...added.map((l) => `+${l}`)].join('\n')

const diff = (...files: string[]): string => `${files.join('\n')}\n`

test('D1 tests count in the total only; code over the limit flags', () => {
  const row = sized(diff(file('src/a.rs', lines(401)), file('src/a_test.go', lines(401))), 400)
  expect(row).toMatchObject({ check: 'size', ok: false })
  expect(row.says.startsWith('401 code lines (802 in all), over 400:')).toBe(true)
})

test('D2 the cut follows the last whole file within the limit', () => {
  const row = sized(diff(file('src/a.rs', lines(300)), file('src/b.rs', lines(150)), file('kit/generated/x.ts', lines(100))), 400)
  expect(row.says).toBe('450 code lines (550 in all), over 400: cut after src/a.rs (300 lines)')
})

test('D3 a file over the limit is cut at a function, or uncuttable', () => {
  const split = lines(500)
  split[119] = 'pub fn split() {'
  expect(sized(diff(file('src/a.rs', split)), 400).says).toBe('500 code lines (500 in all), over 400: cut before src/a.rs:120')
  expect(sized(diff(file('src/a.rs', lines(500))), 400).says).toBe('500 code lines (500 in all), over 400: no cut under 400: src/a.rs alone is 500 lines')
})

test('D4 a diff at or under the limit is a pass naming the limit', () => {
  expect(sized(diff(file('src/a.rs', lines(400))), 400)).toEqual({ check: 'size', ok: true, says: '400 code lines (400 in all), limit 400' })
  expect(sized('', 400)).toEqual({ check: 'size', ok: true, says: '0 code lines (0 in all), limit 400' })
})

const migrated = (): Db => {
  const db = open(':memory:')
  migrate(db, join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'schema'))
  return db
}

const insert = (db: Db, repo: string, n: number): unknown =>
  db.prepare("INSERT INTO size_limits (repo, lines, origin_kind, origin_ref, set_at) VALUES (?, ?, 'ruling', 't', '2026-09-26')").run(repo, n)

test('D5 limitOf reads the repo row, else card.size_limit', () => {
  const db = migrated()
  expect(limitOf(db, 'acme/widget')).toBe(400)
  insert(db, 'acme/widget', 250)
  expect(limitOf(db, 'acme/widget')).toBe(250)
  expect(() => insert(db, 'acme/zero', 0)).toThrow(/CHECK/)
  expect(() => insert(db, 'widget', 100)).toThrow(/CHECK/)
})
