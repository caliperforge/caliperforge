import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5 0083 seeds science.at and set takes a date', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(get(db, 'science.at')).toBe('2026-01-01')
  set(db, 'science.at', '2026-10-04', 'pr', '2026-10-04')
  expect(get(db, 'science.at')).toBe('2026-10-04')
})
