import { expect, test } from 'vitest'
import { weigh } from '../weight.ts'

const hunk = (path: string, at: number, lines: string[]): string =>
  `--- a/${path}\n+++ b/${path}\n@@ -${String(at)},0 +${String(at)},${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`

const SUITE = [
  "import { expect, test } from 'vitest'",
  "import { hello } from './hello.ts'",
  '',
  "test('greets', () => {",
  "  expect(hello()).toBe('hey')",
  "  expect(hello()).toBe('hey')",
  '})',
  '',
  "test('greets again', () => {",
  "  expect(hello()).toBe('hey')",
  "  expect(hello()).toHaveLength(3)",
  '})',
  '',
].join('\n')

const read = (path: string): string => path === 'src/hello.test.ts' ? SUITE : ''
const code = hunk('src/hello.ts', 1, ["export const hello = (): string => 'hey'"])

test('two tests with the same assertion flag by path, line, title', () => {
  const diff = code + hunk('src/hello.test.ts', 5, ["  expect(hello()).toBe('hey')"]) + hunk('src/hello.test.ts', 10, ["  expect(hello()).toBe('hey')"])
  expect(weigh(diff, read)).toEqual({
    check: 'tests',
    ok: false,
    says: `+2 test / +1 code lines; src/hello.test.ts:5 "greets" and src/hello.test.ts:10 "greets again" both assert expect(hello()).toBe('hey')`,
  })
})

test('over twice the code lines in tests flags; twice passes', () => {
  const src = hunk('src/a.ts', 1, [...Array(10).keys()].map((i) => `export const a${String(i)} = ${String(i)}`))
  const tests = (n: number): string => hunk('src/a.test.ts', 1, [...Array(n).keys()].map((i) => `// ${String(i)}`))
  expect(weigh(src + tests(30), read)).toEqual({ check: 'tests', ok: false, says: '+30 test / +10 code lines' })
  expect(weigh(src + tests(20), read)).toEqual({ check: 'tests', ok: true, says: '+20 test / +10 code lines' })
})

test('a repeat within one test or on unadded lines is no flag', () => {
  const inOne = [
    "test('greets', () => {",
    "  expect(hello()).toBe('hey')",
    "  expect(hello()).toBe('hey')",
    '})',
  ].join('\n')
  expect(weigh(code + hunk('src/one.test.ts', 2, ["  expect(hello()).toBe('hey')", "  expect(hello()).toBe('hey')"]), () => inOne))
    .toEqual({ check: 'tests', ok: true, says: '+2 test / +1 code lines' })
  expect(weigh(code + hunk('src/hello.test.ts', 11, ['  expect(hello()).toHaveLength(3)']), read))
    .toEqual({ check: 'tests', ok: true, says: '+1 test / +1 code lines' })
})
