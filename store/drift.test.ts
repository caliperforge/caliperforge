import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { addSetting, setting } from './drift.ts'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5: addSetting on an existing key throws, keeps the value', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const row = { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' } as const
  addSetting(db, row)
  expect(() => { addSetting(db, { ...row, value: '0' }) }).toThrow(/UNIQUE|PRIMARY/)
  expect(setting(db, 'coo_lite.apply')).toBe('1')
})
