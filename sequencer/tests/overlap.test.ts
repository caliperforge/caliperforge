import { expect, test } from 'vitest'
import { tickNote } from '../../cli/brief.ts'
import { record as recordFiles } from '../../store/files.ts'
import { overlapWaits } from '../../store/plans.ts'
import { picks, tick } from '../index.ts'
import { CARRIED, internalPlan, ours, plan, stub, world, type World } from './world.ts'

const ID = 2
const SECOND = 3

/** Two of our own issues in one lane with the cap open for both; every stub brief names `src/hello.ts`. */
function pair(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  internalPlan(w.db, w.root, SECOND, 'let a second internal plan run', 35)
  w.db.prepare('UPDATE pipes SET max_concurrent = 2 WHERE id = 1').run()
  return w
}

const builds = (w: World, id: number): number =>
  (w.db.prepare('SELECT count(*) AS n FROM runs WHERE plan = ? AND step = 2').get(id) as { n: number }).n

/** Both plans briefed, and the first one's builder has run. */
async function oneBuilding(w: World): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
}

test('D1 a plan sharing a path with a building plan is not picked', async () => {
  const w = pair()
  await oneBuilding(w)
  expect(builds(w, ID)).toBeGreaterThan(0)
  expect(builds(w, SECOND)).toBe(0)
  expect(plan(w.db, SECOND).wait_reason).toBe('file_overlap')
  expect(picks(w.db, w.pipe).map((p) => p.id)).not.toContain(SECOND)
})

test('D2 a plan sharing no path builds beside it', async () => {
  const w = pair()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  recordFiles(w.db, SECOND, [{ path: 'src/other.ts', is_new: true }])
  await tick(w.db, w.root, stub(CARRIED))
  expect([builds(w, ID) > 0, builds(w, SECOND) > 0]).toEqual([true, true])
  expect(plan(w.db, SECOND).wait_reason).toBeNull()
})

test('D3 the receipt names the plan it waits on', async () => {
  const w = pair()
  await oneBuilding(w)
  expect(overlapWaits(w.db)).toEqual([{ plan: SECOND, on: ID }])
  expect(tickNote([], overlapWaits(w.db))).toBe(`plan ${String(SECOND)} waits on plan ${String(ID)}`)
})

test('D4 a plan with no file list blocks nothing and waits on nothing', async () => {
  const w = pair()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  recordFiles(w.db, ID, [])
  recordFiles(w.db, SECOND, [])
  await tick(w.db, w.root, stub(CARRIED))
  expect([builds(w, ID) > 0, builds(w, SECOND) > 0]).toEqual([true, true])
})

test('D5 the wait clears when the building plan settles', async () => {
  const w = pair()
  await oneBuilding(w)
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = ?").run(ID)
  await tick(w.db, w.root, stub(CARRIED))
  expect(builds(w, SECOND)).toBeGreaterThan(0)
  expect(plan(w.db, SECOND).wait_reason).toBeNull()
})

test('a plan parked on the ceo holds nothing up', async () => {
  const w = pair()
  await oneBuilding(w)
  w.db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(ID)
  await tick(w.db, w.root, stub(CARRIED))
  expect(builds(w, SECOND)).toBeGreaterThan(0)
})

test('a waiting plan holds no lane slot', async () => {
  const w = pair()
  const THIRD = 4
  internalPlan(w.db, w.root, THIRD, 'let a third internal plan run', 36)
  for (let at = 0; at < 8 && plan(w.db, THIRD).step < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, THIRD).step).toBe(2)
  recordFiles(w.db, THIRD, [{ path: 'src/third.ts', is_new: true }])
  await tick(w.db, w.root, stub(CARRIED))
  expect([builds(w, SECOND), builds(w, THIRD) > 0]).toEqual([0, true])
})
