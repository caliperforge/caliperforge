import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { tick } from '../index.ts'
import { approve, built, CARRIED, internalPlan, moveMain, ours, plan, stub, watched, world, type World } from './world.ts'

const SLOW = 30000

const QUERY = "export const ask = (db: { prepare: (sql: string) => number }): number => db.prepare('SELECT 1')"

function refusing(db: Db): void {
  db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
    VALUES ('ratchet.mode', 'refuse', 'ceo', 'ruling', 'test', '2026-09-26')`).run()
}

function events(db: Db, id: number): number {
  return (db.prepare("SELECT count(*) AS n FROM events WHERE plan = ? AND kind = 'ratchet'").get(id) as { n: number }).n
}

function kernel(debt = false): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  if (debt) moveMain(w.root, 'src/debt.ts', QUERY)
  return w
}

/** Plan `id` taken to step 3 with `line` added to its `src/hello.ts`, and that lap. */
async function railed(w: World, id: number, line: string, issue = 34): Promise<Awaited<ReturnType<typeof tick>>[number] | undefined> {
  internalPlan(w.db, w.root, id, 'let an internal plan run', issue)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, id, line)
  return (await tick(w.db, w.root, stub(CARRIED))).find((f) => f.plan === id)
}

test('D3 with no mode row a job over budget passes and records one event', async () => {
  const w = kernel()
  expect(await railed(w, 2, QUERY)).toMatchObject({ step: 3, outcome: 'pass' })
  expect(plan(w.db, 2).step).toBe(4)
  expect(events(w.db, 2)).toBe(1)
}, SLOW)

test('D4 in refuse mode the same job is refused before the checks', async () => {
  const w = kernel()
  refusing(w.db)
  expect(await railed(w, 2, QUERY)).toMatchObject({ step: 3, outcome: 'refuse', spans: ['ratchet:src/hello.ts'] })
  expect(w.db.prepare("SELECT 1 FROM verdicts WHERE plan = 2 AND rail_id = 'checks'").all()).toEqual([])
}, SLOW)

test('D5 main\'s own debt neither refuses nor records an event', async () => {
  const w = kernel(true)
  refusing(w.db)
  expect(await railed(w, 2, 'export const two = 2')).toMatchObject({ step: 3, outcome: 'pass' })
  expect(events(w.db, 2)).toBe(0)
}, SLOW)

test('D5 a plan on a target never runs the ratchet', async () => {
  const w = world()
  refusing(w.db)
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, w.plan, QUERY)
  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, w.plan)))[0]
  expect(fired).toMatchObject({ step: 3, outcome: 'pass' })
  expect(events(w.db, w.plan)).toBe(0)
}, SLOW)

test('D7 two plans refused by the ratchet alike leave the lane on', async () => {
  const w = kernel()
  refusing(w.db)
  expect(await railed(w, 2, QUERY)).toMatchObject({ outcome: 'refuse' })
  w.db.prepare("UPDATE plans SET state = 'done' WHERE id = 2").run()
  expect(await railed(w, 3, QUERY, 35)).toMatchObject({ outcome: 'refuse', spans: ['ratchet:src/hello.ts'] })
  expect(w.db.prepare('SELECT enabled FROM pipes').all()).toEqual([{ enabled: 1 }])
}, SLOW)
