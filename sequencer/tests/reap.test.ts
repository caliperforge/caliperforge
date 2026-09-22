import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { terminal } from '../../store/plans.ts'
import { planDir, put, reap, srcDir } from '../workspace.ts'
import { world, type World } from './world.ts'

function laid(w: World, plan: number, state: string): string {
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step)
    VALUES (?, ?, 1, 'pr_path', ?, '2026-09-20', 3)`).run(plan, w.pipe.id, state)
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
  const live = ['queued', 'running', 'blocked_on_ceo'].map((state, at) => laid(w, 30 + at, state))
  expect(reap(w.root, terminal(w.db))).toEqual([])
  expect(live.map((dir) => existsSync(dir))).toEqual([true, true, true])
})

test('a second pass over the same plans removes nothing', () => {
  const w = world()
  laid(w, 23, 'done')
  expect(reap(w.root, terminal(w.db))).toEqual([23])
  expect(reap(w.root, terminal(w.db))).toEqual([])
})
