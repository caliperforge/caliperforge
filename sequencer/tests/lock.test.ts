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

test('1991 D1 alone takes every place', () => {
  const r = root()
  expect(lock(r, 2, new Date(), 2, true)).toBeNull()
  expect(readdirSync(join(r, '.cf')).sort()).toEqual(['checks.lock', 'checks.lock.1'])
})

test('1991 D1 alone yields to a holder and keeps no place', () => {
  const r = root()
  lock(r, 1, new Date(), 2)
  expect(lock(r, 2, new Date(), 2, true)?.plan).toBe(1)
  expect(readdirSync(join(r, '.cf'))).toEqual(['checks.lock'])
})

test('unlock frees only its own place', () => {
  const r = root()
  lock(r, 1, new Date(), 2)
  lock(r, 2, new Date(), 2)
  unlock(r, 1)
  expect(readdirSync(join(r, '.cf'))).toEqual(['checks.lock.1'])
  expect(lock(r, 3, new Date(), 2)).toBeNull()
})
