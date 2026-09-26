import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { tick } from '../index.ts'
import { hold, unhold } from '../hold.ts'
import { cloned, planDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, moveMain, ours, plan, stub, watched, world, type World } from './world.ts'

// 09-25: every way a job stops and comes back broke once. These drive a whole lap through the pause.
const ID = 2
const src = (w: World) => join(planDir(w.root, ID), 'src')

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

test('held mid-lap: tree kept, lands after unhold', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  hold(w.db, w.root, ID, 'paused by a person', new Date())
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(cloned(src(w))).toBe(true)
  expect(plan(w.db, ID).state).toBe('blocked_on_ceo')
  unhold(w.db, w.root, ID, 'ceo')
  for (let at = 0; at < 8 && plan(w.db, ID).state !== 'done'; at += 1) {
    await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  }
  expect(plan(w.db, ID).state).toBe('done')
  expect(sent.some((s) => s.startsWith('close caliperforge/caliperforge#34'))).toBe(true)
})

test('held at the brief: back on the main that moved', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  hold(w.db, w.root, ID, 'waits on another job', new Date())
  moveMain(w.root, 'landed-meanwhile.ts')
  unhold(w.db, w.root, ID, 'ceo')
  expect(existsSync(src(w))).toBe(false)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(existsSync(join(src(w), 'landed-meanwhile.ts'))).toBe(true)
})
