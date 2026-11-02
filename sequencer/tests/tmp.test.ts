import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { scoped } from './tmp.ts'

test('D1 tmpdir in a test is an existing cf-test- folder', () => {
  expect(basename(tmpdir())).toMatch(/^cf-test-/)
  expect(statSync(tmpdir()).isDirectory()).toBe(true)
})

test('D2 D3 the cleanup restores TMPDIR and removes the folder', () => {
  const before = process.env.TMPDIR
  const clean = scoped()
  expect(dirname(tmpdir())).toBe(before)
  const made = join(tmpdir(), 'made')
  mkdirSync(made)
  writeFileSync(join(made, 'file'), 'x')
  clean()
  expect(process.env.TMPDIR).toBe(before)
  for (const path of [made, join(made, 'file')]) expect(() => statSync(path)).toThrow(/ENOENT/)
})

test('D2 an unset TMPDIR is unset again after the cleanup', () => {
  const before = tmpdir()
  delete process.env.TMPDIR
  try {
    scoped()()
    expect('TMPDIR' in process.env).toBe(false)
  } finally {
    process.env.TMPDIR = before
  }
})
