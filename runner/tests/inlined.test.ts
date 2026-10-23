import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { INLINE, inlined } from '../inlined.ts'

const ROWS = [...Array(4000).keys()].map((i) => `row ${String(i)} ${'x'.repeat(20)}`)

const small = (path: string): string =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`

const added = ['diff --git a/data.json b/data.json', 'new file mode 100644', 'index 0000000..3333333',
  '--- /dev/null', '+++ b/data.json', `@@ -0,0 +1,${String(ROWS.length)} @@`, ...ROWS.map((r) => `+${r}`)].join('\n')

const deleted = ['diff --git a/old.json b/old.json', 'deleted file mode 100644', 'index 3333333..0000000',
  '--- a/old.json', '+++ /dev/null', `@@ -1,${String(ROWS.length)} +0,0 @@`, ...ROWS.map((r) => `-${r}`)].join('\n')

const addition = (path: string, body: string[]): string =>
  `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${String(body.length)} @@\n${body.map((l) => `+${l}`).join('\n')}`

function line(path: string, section: string, plus: number, minus: number): string {
  const sha = createHash('sha256').update(section).digest('hex')
  return `# ${path} not inlined: ${String(Buffer.byteLength(section, 'utf8'))} bytes, +${String(plus)} -${String(minus)} lines, sha256 ${sha}; read it in the checkout`
}

test('D1 a diff with no section over INLINE comes back as is', () => {
  const git = `${small('a.ts')}\n${small('b.ts')}\n`
  const additions = `${addition('a.ts', ['a', ''])}\n${addition('b.ts', ['b'])}`
  expect(inlined(git)).toBe(git)
  expect(inlined(additions)).toBe(additions)
  expect(Buffer.byteLength(added, 'utf8')).toBeGreaterThan(INLINE)
})

test('D2 an added file over INLINE is one line, neighbours kept', () => {
  const out = inlined(`${small('a.ts')}\n${added}\n${small('b.ts')}\n`)
  expect(out).toBe(`${small('a.ts')}\n${line('data.json', added, ROWS.length, 0)}\n${small('b.ts')}\n`)
})

test('D2 a deleted file over INLINE is named by its old path', () => {
  expect(inlined(`${deleted}\n${small('a.ts')}`)).toBe(`${line('old.json', deleted, 0, ROWS.length)}\n${small('a.ts')}`)
})

test('D2 an additions-form file over INLINE is one line', () => {
  const big = addition('data.json', ROWS)
  expect(inlined(`${addition('a.ts', ['a'])}\n${big}`)).toBe(`${addition('a.ts', ['a'])}\n${line('data.json', big, ROWS.length, 0)}`)
})
