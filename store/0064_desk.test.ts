import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 0064 adds desk tables; only comms.site_dir holds a path', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(db.prepare('SELECT count(*) AS n FROM desk_posts, desk_learnings').get()).toEqual({ n: 0 })
  expect(get(db, 'comms.site_dir')).toBe('')
  set(db, 'comms.site_dir', '/tmp/site', 'ceo', '2026-09-28')
  expect(get(db, 'comms.site_dir')).toBe('/tmp/site')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-09-28') }).toThrow(/CHECK constraint failed/)
})
