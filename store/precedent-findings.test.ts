import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { flag, flagged, type Finding } from './precedent-findings.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const fresh = () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  return db
}

const row: Finding = { finding: 'null check', area: 'a.ts', acted_on: 'fixed', source: 'https://github.com/o/r/pull/7#discussion_r1' }

it('D1 a fresh migrate has no findings', () => {
  expect(flagged(fresh(), 'o/r')).toEqual([])
})

it('D2 flag replaces one PR and leaves the others', () => {
  const db = fresh()
  flag(db, 'o/r', 7, [row, { ...row, acted_on: 'agreed' }])
  flag(db, 'o/r', 8, [{ ...row, finding: 'eight' }])
  flag(db, 'o/r', 7, [{ ...row, acted_on: 'ignored' }])
  expect(flagged(db, 'o/r')).toEqual([{ ...row, finding: 'eight', number: 8 }, { ...row, acted_on: 'ignored', number: 7 }])
})

it('D3 a bad acted_on throws and keeps the earlier rows', () => {
  const db = fresh()
  flag(db, 'o/r', 7, [row])
  expect(() => { flag(db, 'o/r', 7, [row, { ...row, acted_on: 'maybe' as 'fixed' }]) }).toThrow('CHECK constraint failed')
  expect(flagged(db, 'o/r')).toEqual([{ ...row, number: 7 }])
})

it('D4 flagged reads only the repo it is given', () => {
  const db = fresh()
  flag(db, 'o/s', 7, [row])
  flag(db, 'o/r', 8, [row])
  expect(flagged(db, 'o/r')).toEqual([{ ...row, number: 8 }])
})
