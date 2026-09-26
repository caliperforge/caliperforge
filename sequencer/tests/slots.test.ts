import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { free, npm, slot } from '../checks.ts'

test('no limit when unset', () => {
  expect(slot(mkdtempSync(join(tmpdir(), 'cf-slot-')), 0)).toBeNull()
})

test('takes free slots, frees its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-slot-'))
  const a = slot(dir, 2)
  const b = slot(dir, 2)
  expect([a, b].sort()).toEqual([join(dir, 'slot-0'), join(dir, 'slot-1')])
  free(a ?? '')
  expect(existsSync(join(dir, 'slot-0'))).toBe(false)
  expect(slot(dir, 2)).toBe(join(dir, 'slot-0'))
})

test('a dead holder is cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-slot-'))
  writeFileSync(join(dir, 'slot-0'), '999999')
  expect(slot(dir, 1, 10)).toBe(join(dir, 'slot-0'))
})

test('a live holder is waited on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-slot-'))
  const path = join(dir, 'slot-0')
  const holder = spawn(process.execPath, ['-e',
    `require('fs').writeFileSync(${JSON.stringify(path)}, String(process.pid)); setTimeout(() => require('fs').rmSync(${JSON.stringify(path)}), 400)`])
  while (!existsSync(path)) await new Promise((r) => setTimeout(r, 10))
  const began = Date.now()
  expect(slot(dir, 1, 20)).toBe(path)
  expect(Date.now() - began).toBeGreaterThanOrEqual(250)
  holder.kill()
})

test('a check never hands its slots to the tests it runs', () => {
  const was = { n: process.env.CF_CHECK_SLOTS, dir: process.env.CF_CHECK_SLOTS_DIR }
  process.env.CF_CHECK_SLOTS = '2'
  process.env.CF_CHECK_SLOTS_DIR = mkdtempSync(join(tmpdir(), 'cf-slots-'))
  try {
    const ran = npm(['-e', 'process.stdout.write(process.env.CF_CHECK_SLOTS ?? "unset")'], tmpdir(), 'node')
    expect(ran.output).toBe('unset')
  } finally {
    if (was.n === undefined) delete process.env.CF_CHECK_SLOTS
    else process.env.CF_CHECK_SLOTS = was.n
    if (was.dir === undefined) delete process.env.CF_CHECK_SLOTS_DIR
    else process.env.CF_CHECK_SLOTS_DIR = was.dir
  }
})
