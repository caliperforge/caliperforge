import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5 0078 adds drift.at; set refuses a key no migration added', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  set(db, 'drift.at', '2026-10-03', 'pr', '2026-10-03')
  expect(get(db, 'drift.at')).toBe('2026-10-03')
  expect(() => { set(db, 'drift.never', '2026-10-03', 'pr', '2026-10-03') }).toThrow(/no settings row/)
})
