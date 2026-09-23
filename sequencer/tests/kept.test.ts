import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { last as lastMerge } from '../../store/merges.ts'
import { tick } from '../index.ts'
import type { Wire } from '../push.ts'
import { srcDir } from '../workspace.ts'
import { built, CARRIED, internalPlan, moveMain, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

async function ticks(w: World, wire: Wire, n: number): Promise<void> {
  for (let at = 0; at < n; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

/** Steps 0 to 6 with the builder's bytes in the tree; `extra` writes one more file of the job's. */
async function atBatch(w: World, wire: Wire, extra?: [string, string]): Promise<void> {
  await ticks(w, wire, 3)
  built(w.root, ID, 'export const landed = true')
  if (extra !== undefined) writeFileSync(join(srcDir(w.root, ID), extra[0]), extra[1])
  await ticks(w, wire, 4)
}

const reviews = (w: World): number =>
  (w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = ? AND step IN (4, 5)').get(ID) as { n: number }).n

const keptRows = (w: World): unknown[] =>
  w.db.prepare('SELECT gate, tokens FROM verdicts WHERE plan = ? AND kept_by IS NOT NULL ORDER BY id').all(ID)

test('D1 a disjoint clean merge keeps both verdicts', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atBatch(w, wire)
  const before = reviews(w)
  moveMain(w.root, 'after.ts')

  await ticks(w, wire, 1)
  expect(plan(w.db, ID).step).toBe(3)
  expect(lastMerge(w.db, ID)).toMatchObject({ incoming: ['after.ts'], overlap: false, clean: true })

  await ticks(w, wire, 5)
  expect(plan(w.db, ID).step).toBe(8)
  expect(reviews(w)).toBe(before)
  expect(keptRows(w)).toEqual([{ gate: 'review', tokens: 0 }, { gate: 'senior_review', tokens: 0 }])
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = ? AND gate = 'pre_review' ORDER BY id DESC LIMIT 1").get(ID))
    .toEqual({ outcome: 'pass' })
})

test('D2 an overlapping merge repeats the reviews', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atBatch(w, wire)
  const before = reviews(w)
  moveMain(w.root, 'src/hello.ts', readFileSync(join(srcDir(w.root, ID), 'src/hello.ts'), 'utf8'))

  await ticks(w, wire, 1)
  expect(lastMerge(w.db, ID)).toMatchObject({ incoming: ['src/hello.ts'], overlap: true, clean: true })

  await ticks(w, wire, 3)
  expect(reviews(w)).toBeGreaterThan(before)
  expect(keptRows(w)).toEqual([])
})

test('a verdict is kept once per merge', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atBatch(w, wire)
  moveMain(w.root, 'after.ts')
  await ticks(w, wire, 3)
  expect(keptRows(w)).toHaveLength(1)

  w.db.prepare("UPDATE plans SET step = 4, state = 'running' WHERE id = ?").run(ID)
  const before = reviews(w)
  await ticks(w, wire, 1)
  expect(reviews(w)).toBe(before + 1)
  expect(keptRows(w)).toHaveLength(1)
})

test('a merge before any review keeps nothing', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await ticks(w, wire, 3)
  built(w.root, ID, 'export const landed = true')
  moveMain(w.root, 'ahead.ts')

  await ticks(w, wire, 3)
  expect(git(srcDir(w.root, ID), ['log', '--oneline', 'HEAD'])).toContain('main moves on ahead.ts')
  expect(reviews(w)).toBe(2)
  expect(keptRows(w)).toEqual([])
})
