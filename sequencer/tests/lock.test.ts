import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { lock, unlock } from '../lock.ts'

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-lock-'))
  mkdirSync(join(dir, '.cf'))
  return dir
}

test('one wide holds one run', () => {
  const r = root()
  expect(lock(r, 1, new Date(), 1)).toBeNull()
  expect(lock(r, 2, new Date(), 1)?.plan).toBe(1)
})

test('two wide holds two runs and names a holder for the third', () => {
  const r = root()
  expect(lock(r, 1, new Date(), 2)).toBeNull()
  expect(lock(r, 2, new Date(), 2)).toBeNull()
  expect(lock(r, 3, new Date(), 2)?.plan).toBe(1)
})

test('unlock frees only its own place', () => {
  const r = root()
  lock(r, 1, new Date(), 2)
  lock(r, 2, new Date(), 2)
  unlock(r, 1)
  expect(readdirSync(join(r, '.cf'))).toEqual(['checks.lock.1'])
  expect(lock(r, 3, new Date(), 2)).toBeNull()
})
