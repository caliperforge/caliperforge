import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { addPart, allParts } from './parts.ts'
import { addPlan } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D3 a part keeps its given after, or null when given none', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const parent = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  addPart(db, { parent, n: 0, url: 'https://github.com/a/b/issues/2', title: 't', body: 'b' })
  addPart(db, { parent, n: 1, url: 'https://github.com/a/b/issues/3', title: 't', body: 'b', after: 0 })
  expect(allParts(db).map((p) => p.after)).toEqual([null, 0])
})
