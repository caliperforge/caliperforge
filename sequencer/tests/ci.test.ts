import { expect, test } from 'vitest'
import type { Gh } from '../../rails/ci-green/index.ts'
import { tick } from '../index.ts'
import { SHOWS } from '../ci.ts'
import type { Wire } from '../push.ts'
import { CARRIED, internalPlan, ours, plan, runsAfter, runsOn, stub, watched, world, type World } from './world.ts'

const ID = 2

/** The fixture checkout has no package.json, so its laptop checks run nothing. */
const LOCAL = 'pre-review: six rails pass; checks ran none'

const ESC = String.fromCharCode(27)

const LOG = [
  `check\tRun npm run test\t2026-09-26T13:10:02.1234567Z ${ESC}[31m FAIL ${ESC}[39m src/hello.test.ts > hello > says hey`,
  'check\tRun npm run test\t2026-09-26T13:10:02.1534567Z ^[[41m^[[1m FAIL ^[[22m^[[49m src/bye.test.ts^[[2m > ^[[22mbye > says bye',
  'check\tRun npm run test\t2026-09-26T13:10:02.2234567Z AssertionError: expected "hi" to be "hey"',
  'check\tRun npm run test\t2026-09-26T13:10:03.0000000Z ##[error]Process completed with exit code 1.',
].join('\n')

function mine(where: string | null = 'ci'): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  if (where !== null) {
    w.db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
      VALUES ('checks.where', ?, 'ceo', 'ruling', 'ceo-2026-09-26', '2026-09-26')`).run(where)
  }
  return w
}

async function toRails(w: World, wire: Wire): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

async function rails(w: World, wire: Wire): Promise<{ step: number; outcome: string; note: string; spans: string[] } | undefined> {
  return (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
}

test('green at the head passes step 3 without the laptop suite', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await toRails(w, wire)
  const fired = await rails(w, wire)
  expect(fired).toMatchObject({ step: 3, outcome: 'pass' })
  expect(fired?.note).toContain('checks ran on GitHub CI at caliperforge/caliperforge@')
  expect(sent).toEqual(['send src +p2-let-an-internal-plan-run'])
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = ? AND rail_id = 'checks'").get(ID)).toEqual({ outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
})

test('no run yet holds step 3, then the run passes it', async () => {
  const w = mine()
  const wire = watched([], w.root, ID, runsAfter(w.root, ID, 1))
  await toRails(w, wire)
  expect(await rails(w, wire)).toMatchObject({ step: 3, outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(3)
  expect(w.db.prepare('SELECT doing FROM now WHERE plan = ?').get(ID)).toEqual({ doing: 'waiting on CI' })
  expect((await rails(w, wire))?.note).toContain('GitHub CI')
  expect(plan(w.db, ID).step).toBe(4)
})

test('red sends the build back naming the failing test', async () => {
  const w = mine()
  const listed = runsOn(w.root, ID, 'completed', 'failure')
  const gh: Gh = (args) => (args.includes('--log-failed') ? LOG : listed(args))
  const wire = watched([], w.root, ID, gh)
  await toRails(w, wire)
  const fired = await rails(w, wire)
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse' })
  expect(fired?.spans).toEqual(['checks:test', 'src/hello.test.ts hello > says hey', 'src/bye.test.ts bye > says bye'])
  expect(fired?.note).toBe('npm run test on GitHub CI exit 1')
  expect(plan(w.db, ID).step).toBe(2)
})

test('no run past the window runs the suite on the laptop', async () => {
  const w = mine()
  const wire = watched([], w.root, ID, () => '[]')
  await toRails(w, wire)
  for (let at = 0; at < SHOWS; at += 1) await rails(w, wire)
  expect(plan(w.db, ID).step).toBe(3)
  expect((await rails(w, wire))?.note).toBe(LOCAL)
})

test('a push that fails runs the suite on the laptop', async () => {
  const w = mine()
  const wire: Wire = { ...watched([], w.root, ID), send: () => { throw new Error('offline') } }
  await toRails(w, wire)
  expect((await rails(w, wire))?.note).toBe(LOCAL)
  expect(w.db.prepare("SELECT plan, actor, message FROM events WHERE kind = 'swallowed'").all())
    .toEqual([{ plan: ID, actor: 'ciChecks', message: 'offline' }])
})

test('without the switch the laptop runs the suite and nothing is sent', async () => {
  const w = mine(null)
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await toRails(w, wire)
  expect((await rails(w, wire))?.note).toBe(LOCAL)
  expect(sent).toEqual([])
})
