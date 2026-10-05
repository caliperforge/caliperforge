import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { addPlan, holdOn, requeue } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 0082 holdOn stores held_until; leaving the hold clears it', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 4 })
  const until = (): unknown => db.prepare('SELECT held_until FROM plans WHERE id = ?').get(plan)
  holdOn(db, plan, 'recheck', null, '2026-10-04T22:00:00.000Z')
  expect(until()).toEqual({ held_until: '2026-10-04T22:00:00.000Z' })
  requeue(db, plan, 4)
  expect(until()).toEqual({ held_until: null })
})
