import { expect, test } from 'vitest'
import { internalPlan, world, type World } from '../sequencer/tests/world.ts'
import { runAt } from './events.ts'
import { ahead, record, sharing } from './files.ts'
import { addRule } from './index.ts'
import { waiting } from './plans.ts'

const OLD = 2
const YOUNG = 3

/** Two unbuilt internal plans past their brief, both listing `src/a.ts`. */
function unbuilt(old: number, young: number): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  internalPlan(w.db, w.root, OLD, 'older', 34, old)
  internalPlan(w.db, w.root, YOUNG, 'younger', 35, young)
  w.db.prepare('UPDATE plans SET step = 2').run()
  record(w.db, OLD, [{ path: 'src/a.ts', is_new: false }])
  record(w.db, YOUNG, [{ path: 'src/a.ts', is_new: false }])
  return w
}

test('same priority: younger waits', () => {
  const w = unbuilt(1, 1)
  expect(sharing(w.db, YOUNG)).toEqual({ plan: OLD, path: 'src/a.ts' })
  expect(sharing(w.db, OLD)).toBeNull()
})

test('younger P0 goes first', () => {
  const w = unbuilt(1, 0)
  expect(sharing(w.db, YOUNG)).toBeNull()
  expect(sharing(w.db, OLD)).toEqual({ plan: YOUNG, path: 'src/a.ts' })
})

/** `unbuilt`, with the older plan's build run. */
function built(old: number, young: number): World {
  const w = unbuilt(old, young)
  addRule(w.db, { id: 'builder', kind: 'card', path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-18T00:00:00.000Z' })
  runAt(w.db, OLD, 2, 'builder', '2026-09-18 00:00:00')
  return w
}

test('D2 a built P1 stands aside for a P0 on its files', () => {
  expect(ahead(built(1, 0).db, OLD)).toBe(YOUNG)
  expect(ahead(unbuilt(1, 0).db, OLD)).toBeNull()
  expect(ahead(built(1, 1).db, OLD)).toBeNull()
  const w = built(1, 0)
  waiting(w.db, [{ plan: YOUNG, why: 'ceo_batch' }])
  expect(ahead(w.db, OLD)).toBeNull()
})
