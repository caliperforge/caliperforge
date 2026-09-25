import { expect, test } from 'vitest'
import { classify } from '../delta.ts'

const diff = (path: string, lines: string[]): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`

const CODE = [...Array(10).keys()].map((i) => `export const v${String(i)} = ${String(i)}`)
const PASSED = diff('a.ts', CODE) + diff('README.md', ['# t'])

test('D1 a counted path outside the passed diff is a full review, named', () => {
  expect(classify(PASSED, diff('b.ts', ['x']), ['b.ts'])).toEqual({ mode: 'full', why: 'b.ts is not in the passed diff' })
})

test('D2 a delta over half the passed diff is a full review, with both counts', () => {
  expect(classify(PASSED, diff('a.ts', CODE.slice(0, 6)), ['a.ts'])).toEqual({ mode: 'full', why: '6 delta lines is over half of 11 passed' })
})

test('comment lines, a .md file and an empty delta are comment-only', () => {
  expect(classify(PASSED, diff('a.ts', ['// x', '', ' * y', '/* z']), ['a.ts']).mode).toBe('comment')
  expect(classify(PASSED, diff('README.md', ['const words = 1']), ['README.md']).mode).toBe('comment')
  expect(classify(PASSED, '', [])).toEqual({ mode: 'comment', why: '0 delta lines, comments and docs only' })
})

test('D4 one code line beside a comment is a delta', () => {
  expect(classify(PASSED, diff('a.ts', ['// x', 'const y = 1']), ['a.ts'])).toEqual({ mode: 'delta', why: '2 delta lines of 11 passed, inside the passed diff' })
})

test('no passed diff keeps the delta against the tree last judged', () => {
  expect(classify(null, diff('b.ts', CODE), ['b.ts'])).toEqual({ mode: 'delta', why: 'no passed diff on file, so against the tree last judged' })
})

test('paths main brought in are not counted', () => {
  expect(classify(PASSED, diff('main.ts', CODE) + diff('a.ts', ['// x']), ['a.ts']).mode).toBe('comment')
})
