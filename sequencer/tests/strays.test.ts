import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { filesOf, record as recordFiles, sharing } from '../../store/files.ts'
import { tick } from '../index.ts'
import { srcDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const ID = 2
const SECOND = 3

/** Two of our own plans, both built: the first on `src/hello.ts`, the second listed on its own file. */
async function builtPair(): Promise<World> {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  internalPlan(w.db, w.root, SECOND, 'let a second internal plan run', 35)
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  recordFiles(w.db, SECOND, [{ path: 'src/p3.ts', is_new: true }])
  await tick(w.db, w.root, stub(CARRIED))
  built(w.root, ID, 'export const landed = true')
  writeFileSync(join(srcDir(w.root, SECOND), 'src/p3.ts'), 'export const p3 = true\n')
  return w
}

const paths = (w: World, id: number): string[] =>
  (w.db.prepare('SELECT path FROM plan_files WHERE plan = ? ORDER BY position').all(id) as { path: string }[]).map((r) => r.path)

test('D1 a stray path joins the recorded set', async () => {
  const w = await builtPair()
  writeFileSync(join(srcDir(w.root, SECOND), 'src/stray.ts'), 'export const stray = 1\n')
  await tick(w.db, w.root, stub(CARRIED))
  expect(paths(w, SECOND)).toEqual(['src/p3.ts', 'src/stray.ts'])
  expect(filesOf(w.db, SECOND).map((f) => f.path)).toEqual(['src/p3.ts'])
})

test('D2 a stray path an older job is building holds at the rails', async () => {
  const w = await builtPair()
  built(w.root, SECOND, 'export const also = true')
  const fired = await tick(w.db, w.root, stub(CARRIED))
  const second = fired.find((f) => f.plan === SECOND)
  expect(second).toMatchObject({ step: 3, name: 'rails', state: 'running', spans: ['src/hello.ts'] })
  expect(second?.note).toContain(`plan ${String(ID)} is building`)
  expect(plan(w.db, SECOND).step).toBe(3)
  expect(fired.find((f) => f.plan === ID)).toMatchObject({ step: 3, outcome: 'pass' })
})

test('D3 a stray nobody holds meets the authority rail as before', async () => {
  const w = await builtPair()
  writeFileSync(join(srcDir(w.root, SECOND), 'src/stray.ts'), 'export const stray = 1\n')
  const second = (await tick(w.db, w.root, stub(CARRIED))).find((f) => f.plan === SECOND)
  expect(second?.note).not.toContain('is building')
  expect(second).toMatchObject({ outcome: 'refuse', spans: ['src/stray.ts:1 authority.outside_files'] })
})

test('a held job goes on when the older one settles when the older one settles', async () => {
  const w = await builtPair()
  built(w.root, SECOND, 'export const also = true')
  await tick(w.db, w.root, stub(CARRIED))
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = ?").run(ID)
  const second = (await tick(w.db, w.root, stub(CARRIED))).find((f) => f.plan === SECOND)
  expect(second?.note).not.toContain('is building')
})

test('D4 the next pick reads the stray', async () => {
  const w = await builtPair()
  writeFileSync(join(srcDir(w.root, SECOND), 'src/stray.ts'), 'export const stray = 1\n')
  await tick(w.db, w.root, stub(CARRIED))
  internalPlan(w.db, w.root, 4, 'let a third internal plan run', 36)
  recordFiles(w.db, 4, [{ path: 'src/stray.ts', is_new: false }])
  expect(sharing(w.db, 4)).toEqual({ plan: SECOND, path: 'src/stray.ts' })
})
