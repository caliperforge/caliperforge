import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { headApproved } from '../../store/approvals.ts'
import { tick } from '../index.ts'
import { headOf, land, type Wire } from '../push.ts'
import { conflicted, diffOf, fetchMain, get, liveTree, MAIN, srcDir } from '../workspace.ts'
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

/** Steps 0 to 2: the plan is on the rails step with the builder's bytes in the tree, uncommitted. */
async function atRails(w: World, wire: Wire, id = ID): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, id, 'export const landed = true')
}

/** Steps 0 to 6: the builder's bytes land at step 2, and step 6 sends the branch to the fork. */
async function atBatch(w: World, wire: Wire): Promise<void> {
  await atRails(w, wire)
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
  expect(sent).toEqual(['send src widget-12-a1', 'rehearse caliperforge/widget widget-12-a1'])
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

test('a stale tree merges main before the rails read it and records the new base, in one tick', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  expect(plan(w.db, ID).step).toBe(3)
  moveMain(w.root, 'ahead.ts')

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(fired).toMatchObject({ step: 3, name: 'rails', outcome: 'pass' })
  expect(plan(w.db, ID).step).toBe(4)
  expect(git(src, ['log', '--oneline', 'HEAD'])).toContain('main moves on ahead.ts')
  expect(get(w.root, ID, 'base.sha').trim()).toBe(git(src, ['rev-parse', MAIN]))
  expect(diffOf(w.root, ID)).toContain('export const landed = true')
})

test('a tree already at main\'s head gains no commit at the rails and its base.sha is byte-identical', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', 'HEAD'])
  const base = get(w.root, ID, 'base.sha')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(git(src, ['rev-parse', 'HEAD'])).toBe(head)
  expect(get(w.root, ID, 'base.sha')).toBe(base)
})

test('a merge that conflicts at the rails aborts, hands the builder the paths and spends no retry', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  const src = srcDir(w.root, ID)
  const base = get(w.root, ID, 'base.sha')
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(conflicted(src)).toBe(false)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(get(w.root, ID, 'base.sha')).toBe(base)
  expect(get(w.root, ID, 'refusal.md')).toContain('src/hello.ts')
})

test('a tree a tick stopped mid-merge in commits no conflict marker at the rails', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  const src = srcDir(w.root, ID)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  headOf(w.root, ID)
  fetchMain(src)
  expect(() => git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', MAIN])).toThrow()
  expect(conflicted(src)).toBe(true)

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(conflicted(src)).toBe(false)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(diffOf(w.root, ID)).not.toContain('<<<<<<<')
  expect(git(src, ['log', '-p', BRANCH])).not.toContain('<<<<<<<')
})

test('the merge the rails step makes is the machine\'s commit, not the host user\'s', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  moveMain(w.root, 'ahead.ts')

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(git(srcDir(w.root, ID), ['log', '-1', '--format=%ae %ce', 'HEAD']))
    .toBe('cf@caliperforge.dev cf@caliperforge.dev')
})

test('a target\'s tree at the rails is untouched when our own main moves', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  await atRails(w, wire, 1)
  ours(w.root)
  moveMain(w.root, 'ahead.ts')
  const src = srcDir(w.root, 1)
  const head = git(src, ['rev-parse', 'HEAD'])
  const base = get(w.root, 1, 'base.sha')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(git(src, ['rev-parse', 'HEAD'])).toBe(head)
  expect(get(w.root, 1, 'base.sha')).toBe(base)
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
