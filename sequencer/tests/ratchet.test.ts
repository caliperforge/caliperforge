import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { openPipes } from '../../store/plans.ts'
import { tick } from '../index.ts'
import { lock, unlock } from '../lock.ts'
import { approve, built, CARRIED, internalPlan, moveMain, ours, plan, stub, watched, world, type World } from './world.ts'

const SLOW = 30000

const eventsOf = (db: Db, plan: number): unknown[] =>
  db.prepare("SELECT actor, outcome, message FROM events WHERE plan = ? AND kind = 'ratchet' ORDER BY id").all(plan)

const CAUGHT = 'export const ask = (f: () => number): number | null => { try { return f() } catch { return null } }'

function refusing(db: Db): void {
  db.exec(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
    VALUES ('ratchet.mode', 'refuse', 'ceo', 'ruling', 'test', '2026-09-26')`)
}

function kernel(debt = false): World {
  const w = world()
  w.db.exec('DELETE FROM plans WHERE id = 1')
  ours(w.root)
  if (debt) moveMain(w.root, 'src/debt.ts', CAUGHT)
  return w
}

/** Plan `id` taken to step 3 with `line` added to its `src/hello.ts`, and that lap. */
async function railed(w: World, id: number, line: string, issue = 34): Promise<Awaited<ReturnType<typeof tick>>[number] | undefined> {
  internalPlan(w.db, w.root, id, 'let an internal plan run', issue)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, id, line)
  return (await tick(w.db, w.root, stub(CARRIED))).find((f) => f.plan === id)
}

test('D3 with no mode row a job over budget passes, one event', async () => {
  const w = kernel()
  lock(w.root, 9)
  expect(await railed(w, 2, CAUGHT)).toMatchObject({ step: 3, held: true })
  expect(eventsOf(w.db, 2)).toEqual([])
  unlock(w.root, 9)
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 3, outcome: 'pass' })
  expect(plan(w.db, 2).step).toBe(4)
  expect(eventsOf(w.db, 2)).toEqual([{ actor: 'ratchet', outcome: 'pass',
    message: 'would refuse: src/hello.ts silent-catch 1 over budget 0: rethrow or record an event with logged()' }])
}, SLOW)

test('D4 in refuse mode the same job is refused before the checks', async () => {
  const w = kernel()
  refusing(w.db)
  lock(w.root, 9)
  expect(await railed(w, 2, CAUGHT)).toMatchObject({ step: 3, outcome: 'refuse', spans: ['ratchet:src/hello.ts'],
    note: 'ratchet: the job grew a file past its budget' })
}, SLOW)

test('D5 main\'s own debt neither refuses nor records an event', async () => {
  const w = kernel(true)
  refusing(w.db)
  expect(await railed(w, 2, 'export const two = 2')).toMatchObject({ step: 3, outcome: 'pass' })
  expect(eventsOf(w.db, 2)).toEqual([])
}, SLOW)

test('D5 a plan on a target never runs the ratchet', async () => {
  const w = world()
  refusing(w.db)
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, w.plan, CAUGHT)
  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, w.plan)))[0]
  expect(fired).toMatchObject({ step: 3, outcome: 'pass' })
  expect(eventsOf(w.db, w.plan)).toEqual([])
}, SLOW)

test('D7 two plans refused by the ratchet alike leave the lane on', async () => {
  const w = kernel()
  refusing(w.db)
  expect(await railed(w, 2, CAUGHT)).toMatchObject({ outcome: 'refuse' })
  w.db.exec("UPDATE plans SET state = 'done' WHERE id = 2")
  expect(await railed(w, 3, CAUGHT, 35)).toMatchObject({ outcome: 'refuse', spans: ['ratchet:src/hello.ts'] })
  expect(openPipes(w.db, '12:00')).toHaveLength(1)
}, SLOW)
