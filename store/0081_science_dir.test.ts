import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5 0081 seeds science.dir and lets it hold a path', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(get(db, 'science.dir')).toBe('~/Documents/Claude/Projects/HQ/science')
  set(db, 'science.dir', '/tmp/x', 'ceo', '2026-10-03')
  expect(get(db, 'science.dir')).toBe('/tmp/x')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-10-03') }).toThrow(/CHECK constraint failed/)
})
