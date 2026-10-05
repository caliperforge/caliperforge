import { expect, test } from 'vitest'
import { internalPlan, world, type World } from '../sequencer/tests/world.ts'
import { record, sharing } from './files.ts'

const OLD = 2
const YOUNG = 3

/** Two unbuilt internal plans past their brief, both listing `rules.seed.sql`. */
function unbuilt(old: number, young: number): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  internalPlan(w.db, w.root, OLD, 'older', 34, old)
  internalPlan(w.db, w.root, YOUNG, 'younger', 35, young)
  w.db.prepare('UPDATE plans SET step = 2').run()
  record(w.db, OLD, [{ path: 'rules.seed.sql', is_new: false }])
  record(w.db, YOUNG, [{ path: 'rules.seed.sql', is_new: false }])
  return w
}

test('same priority: younger waits', () => {
  const w = unbuilt(1, 1)
  expect(sharing(w.db, YOUNG)).toEqual({ plan: OLD, path: 'rules.seed.sql' })
  expect(sharing(w.db, OLD)).toBeNull()
})

test('younger P0 goes first', () => {
  const w = unbuilt(1, 0)
  expect(sharing(w.db, YOUNG)).toBeNull()
  expect(sharing(w.db, OLD)).toEqual({ plan: YOUNG, path: 'rules.seed.sql' })
})
