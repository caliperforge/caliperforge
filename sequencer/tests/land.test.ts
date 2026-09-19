import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { headApproved } from '../../store/approvals.ts'
import { tick } from '../index.ts'
import { headOf, land, type Wire } from '../push.ts'
import { liveTree, srcDir } from '../workspace.ts'
import { approve, built, CARRIED, internalPlan, moveMain, ours, plan, stub, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'
const FORKED = `send src ${BRANCH}`

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

/** Steps 0 to 6: the builder's bytes land at step 2, and step 6 sends the branch to the fork. */
async function atBatch(w: World, wire: Wire): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

test('an internal plan that passed ready is on main, pushed and its issue closed, in the next tick', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT outcome, step FROM verdicts WHERE plan = ? AND rail_id = 'ci-green'").get(ID))
    .toEqual({ outcome: 'pass', step: 6 })

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  const sha = git(src, ['rev-parse', 'main'])
  expect(fired).toMatchObject({ step: 7, name: 'batch', outcome: 'pass', state: 'running' })
  expect(fired?.note).toBe(`landed ${BRANCH} on main as ${sha.slice(0, 12)}`)
  expect(sha).toBe(git(src, ['rev-parse', BRANCH]))
  expect(sent).toEqual([FORKED, 'send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
  expect(w.db.prepare('SELECT state, evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .toEqual({ state: 'pushed', evidence: `https://github.com/caliperforge/caliperforge/commit/${sha}` })
  expect(headApproved(w.db, sha)).toBe(true)

  const last = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(last).toMatchObject({ step: 8, name: 'push', outcome: 'pass', state: 'done' })
  expect(sent).toHaveLength(3)
})

test('main moving between ready and batch rewinds to the rails and lands as a fast-forward on the second pass', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  moveMain(w.root, 'after.ts')

  const held = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(held).toMatchObject({ step: 7, outcome: 'pass', state: 'running', spans: ['base:stale'] })
  expect(plan(w.db, ID).step).toBe(3)
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE who = 'gates'").get()).toEqual({ n: 0 })
  expect(git(src, ['rev-list', '--count', `main..${BRANCH}`])).not.toBe('0')

  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const sha = git(src, ['rev-parse', 'main'])
  expect(plan(w.db, ID).step).toBe(8)
  expect(sha).toBe(git(src, ['rev-parse', BRANCH]))
  expect(git(src, ['rev-list', '--parents', '-n', '1', 'main']).split(' ')).toHaveLength(3)
  expect(git(src, ['rev-list', '--first-parent', 'main'])).toContain(sha)
  expect(sent).toEqual([FORKED, FORKED, 'send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
  expect(headApproved(w.db, sha)).toBe(true)
})

test('a branch that conflicts with a moved main refuses at batch, aborts the merge and closes nothing', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(refused).toMatchObject({ step: 7, outcome: 'refuse', spans: ['base:conflict'] })
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE who = 'gates'").get()).toEqual({ n: 0 })
  expect(w.db.prepare('SELECT state FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .not.toEqual({ state: 'pushed' })
})

test('a main that moves inside the tick makes the land a refusal, not a merge commit', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', BRANCH])
  moveMain(w.root, 'racing.ts')

  const refused = land(w.db, w.root, plan(w.db, ID), 1, wire)
  expect(refused).toMatchObject({ outcome: 'refuse', spans: ['base:stale'] })
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['rev-parse', BRANCH])).toBe(head)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT count(*) AS n FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(ID))
    .toEqual({ n: 0 })
})

test('an external plan does not land: step 7 still waits for the ceo and step 8 opens a pull request', async () => {
  const w = world()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1)
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)

  expect(plan(w.db, 1).step).toBe(7)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]).toBeUndefined()
  expect(sent).toEqual(['send src widget-12-a1'])
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE who = 'gates'").get()).toEqual({ n: 0 })
  expect(git(srcDir(w.root, 1), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('widget-12-a1')
})

test('a base behind main merges main and re-runs the rails once, then refuses on the second miss', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, ID).step).toBe(6)
  moveMain(w.root, 'first.ts')

  const merged = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(merged).toMatchObject({ step: 6, outcome: 'pass', state: 'running', spans: ['base:stale'] })
  expect(plan(w.db, ID).step).toBe(3)
  expect(git(srcDir(w.root, ID), ['log', '--oneline', BRANCH])).toContain('main moves on first.ts')

  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, ID).step).toBe(6)
  moveMain(w.root, 'second.ts')
  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 6, outcome: 'refuse', spans: ['base:stale'] })
  expect(refused?.note).toContain('behind main a second time')
  expect(headOf(w.root, ID).branch).toBe(BRANCH)
})

test('a seat works in the plan checkout and nowhere else under the machine\'s own tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-live-'))
  expect(liveTree(root, root)).toBe(true)
  expect(liveTree(root, join(root, 'store'))).toBe(true)
  expect(liveTree(root, join(root, '.cf/work'))).toBe(true)
  expect(liveTree(root, srcDir(root, 2))).toBe(false)
  expect(liveTree(root, join(srcDir(root, 2), 'store'))).toBe(false)
  expect(liveTree(root, tmpdir())).toBe(false)
})
