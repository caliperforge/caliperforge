import { expect, test } from 'vitest'
import { approved } from '../approve.ts'
import { approve, plan, world } from './world.ts'

test('a plan with no target is not approved', () => {
  const w = world()
  expect(approved(w.db, { ...plan(w.db, w.plan), target_id: null })).toBe(false)
})

test('a target is approved once its measurement is signed', () => {
  const w = world()
  expect(approved(w.db, plan(w.db, w.plan))).toBe(false)
  approve(w.db, w.target)
  expect(approved(w.db, plan(w.db, w.plan))).toBe(true)
})
