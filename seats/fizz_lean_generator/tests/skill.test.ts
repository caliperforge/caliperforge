import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '../../..')
const skill = join(root, 'seats/fizz_lean_generator/skill')
const fizz = readFileSync(join(root, 'seats/fizz_generator/prompt.md'), 'utf8')
const file = readFileSync(join(skill, 'SKILL.md'), 'utf8')
const STEP_0 = '## Step 0: Print Banner'
const TITLE = '\n# Fizz\n\n'

function at(heading: string): number {
  const i = fizz.indexOf(`\n${heading}`)
  expect(i).toBeGreaterThan(-1)
  return i + 1
}

function line(pattern: RegExp): string {
  const found = pattern.exec(fizz)?.[0] ?? ''
  expect(found).not.toBe('')
  return found
}

const preamble = fizz.slice(fizz.indexOf(TITLE) + TITLE.length, at(STEP_0))

function stepless(text: string): void {
  expect(text).not.toMatch(/^#{2,3} Step /m)
  const [kept, held] = [new Set(preamble.split('\n')), new Set(text.split('\n'))]
  const copied = fizz.slice(at(STEP_0)).split('\n').filter((row) => row.length >= 40 && !kept.has(row) && held.has(row))
  expect(copied).toEqual([])
}

function copied(text: string): void {
  expect(text).toBe(`---\nname: fizz_lean\n${line(/^description: .*$/m)}\n---\n\n# Fizz lean\n\n${preamble.trimEnd()}\n`)
}

test('D1: SKILL.md is the preamble verbatim and nothing after', () => {
  copied(file)
})

test('D2: a Conductor appended after the preamble fails', () => {
  expect(() => { copied(`${file}\n## Conductor\n`) }).toThrow()
})

test('D4: no step heading or step line, and a Step 6 line fails', () => {
  stepless(file)
  expect(() => { stepless(`${file}${line(/^Modify the scaffolded core files.*$/m)}\n`) }).toThrow()
})
