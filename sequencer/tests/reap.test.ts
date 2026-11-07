import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type PlanRow, putPlan, terminal } from '../../store/plans.ts'
import { planDir, put, reap, srcDir } from '../workspace.ts'
import { world, type World } from './world.ts'

function laid(w: World, plan: number, state: PlanRow['state']): string {
  putPlan(w.db, { id: plan, pipe_id: w.pipe.id, target_id: 1, template: 'pr_path', state, queued_at: '2026-09-20', step: 3, retries: 0 })
  writeFileSync(join(srcDir(w.root, plan), 'hello.ts'), 'export const hello = 1\n')
  put(w.root, plan, 'refusal.md', 'the rails said no\n')
  return join(planDir(w.root, plan), 'src')
}

test('a finished plan loses its checkout and keeps its paper', () => {
  const w = world()
  const src = laid(w, 20, 'done')
  expect(reap(w.root, terminal(w.db))).toEqual([20])
  expect(existsSync(src)).toBe(false)
  expect(existsSync(join(planDir(w.root, 20), 'refusal.md'))).toBe(true)
})

test('refused and halted go the same way', () => {
  const w = world()
  const gone = [laid(w, 21, 'refused'), laid(w, 22, 'halted')]
  expect(reap(w.root, terminal(w.db)).sort()).toEqual([21, 22])
  expect(gone.map((dir) => existsSync(dir))).toEqual([false, false])
})

test('a plan still in play keeps its checkout', () => {
  const w = world()
  const live = (['queued', 'running', 'blocked_on_ceo'] as const).map((state, at) => laid(w, 30 + at, state))
  expect(reap(w.root, terminal(w.db))).toEqual([])
  expect(live.map((dir) => existsSync(dir))).toEqual([true, true, true])
})

test('a walled plan keeps src/ until its suite is archived', () => {
  const w = world()
  const src = laid(w, 24, 'done')
  mkdirSync(join(src, 'test/fizz'), { recursive: true })
  put(w.root, 24, 'generate.json', JSON.stringify({ suite: 'test/fizz', wall: 'the cost wall' }))
  expect(reap(w.root, terminal(w.db))).toEqual([])
  expect(existsSync(join(src, 'test/fizz'))).toBe(true)
  put(w.root, 24, 'generate.json', JSON.stringify({ suite: 'test/fizz', wall: 'the cost wall', partial: 'the cost wall' }))
  expect(reap(w.root, terminal(w.db))).toEqual([24])
  expect(existsSync(src)).toBe(false)
})

test('a second pass over the same plans removes nothing', () => {
  const w = world()
  laid(w, 23, 'done')
  expect(reap(w.root, terminal(w.db))).toEqual([23])
  expect(reap(w.root, terminal(w.db))).toEqual([])
})
