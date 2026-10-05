import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { setLimit } from './limits.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D4: a size limit of 0 lines is refused', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(() => { setLimit(db, { repo: 'acme/widget', lines: 0, origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' }) }).toThrow(/CHECK/)
})
