import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { headApproved } from '../../store/approvals.ts'
import { last as lastMerge } from '../../store/merges.ts'
import { tick } from '../index.ts'
import { LAPS } from '../merge.ts'
import { COMMIT, commitMessage, headOf, land, sent, WIRE, type Wire } from '../push.ts'
import { CARRY, carried, cloned, conflicted, diffOf, drop, fetchMain, get, liveTree, maybe, MAIN, put, SELF, srcDir } from '../workspace.ts'
import { SCHEDULED } from './bases.ts'
import { approve, built, CARRIED, internalPlan, moveMain, ours, PASS, plan, stub, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'
const FORKED = `send src ${BRANCH}`

const MESSAGE = 'let an internal plan run\n\nadd `hello()`.\n\nthe ask asks for it.\n\nCloses caliperforge/caliperforge#34\nPlan 2'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const bodies = (cwd: string, range: string): string[] =>
  git(cwd, ['log', '--no-merges', '--format=%B%x00', range]).split('\0').map((m) => m.trim()).filter((m) => m !== '')

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

test('a ready internal plan lands and closes its issue next tick', async () => {
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

test('each landed commit carries title, what, why, close and plan', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atBatch(w, wire)
  expect(w.db.prepare("SELECT outcome, step FROM verdicts WHERE plan = ? AND rail_id = 'ci-green'").get(ID))
    .toEqual({ outcome: 'pass', step: 6 })
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(new Set(bodies(srcDir(w.root, ID), `${MAIN}..main`))).toEqual(new Set([MESSAGE]))
})

test('a second round adds a same-message commit after the first', async () => {
  const w = mine()
  await atRails(w, watched([], w.root, ID))
  const first = headOf(w.root, ID).sha
  built(w.root, ID, 'export const again = true')
  headOf(w.root, ID)
  const src = srcDir(w.root, ID)
  expect(bodies(src, `${MAIN}..HEAD`)).toEqual([MESSAGE, MESSAGE])
  expect(git(src, ['rev-parse', 'HEAD~1'])).toBe(first)
})

test('a bare upstream number in the brief stays out of the commit', () => {
  const w = mine()
  put(w.root, ID, 'issue.md', '# let #35 run\n\n**What:** add it.\n**Why:** #35 asks for it.\n')
  const message = commitMessage(w.root, plan(w.db, ID))
  expect(message).toBe('let run\n\nadd it.\n\nasks for it.\n\nCloses caliperforge/caliperforge#34\nPlan 2')
})

test('with no saved message a plan commits under its branch name', async () => {
  const w = mine()
  await atRails(w, watched([], w.root, ID))
  drop(w.root, ID, COMMIT)
  headOf(w.root, ID)
  expect(bodies(srcDir(w.root, ID), `${MAIN}..HEAD`)).toEqual([BRANCH])
})

test('an atelier plan installs the app once, after send and close', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  w.db.prepare("UPDATE plans SET lane = 'atelier' WHERE id = ?").run(ID)

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const sha = git(srcDir(w.root, ID), ['rev-parse', 'main'])
  expect(sent).toEqual([FORKED, 'send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`, 'install'])
})

test('with no workflows a plan lands on step 3\'s checks', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root, undefined, false)
  internalPlan(w.db, w.root, ID)
  const sent: string[] = []
  const wire = watched(sent, w.root, ID, () => { throw new Error('no workflows: github is never asked for runs') })
  await atBatch(w, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(sent).toEqual([])
  expect(w.db.prepare("SELECT outcome, step FROM verdicts WHERE plan = ? AND rail_id = 'ci-green'").get(ID))
    .toEqual({ outcome: 'pass', step: 6 })
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = ? AND rail_id = 'ready'").get(ID))
    .toEqual({ outcome: 'pass' })

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const sha = git(srcDir(w.root, ID), ['rev-parse', 'main'])
  expect(sent).toEqual(['send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
})

test('a schedule-only workflow lands the plan on step 3\'s checks', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root, SCHEDULED, false)
  internalPlan(w.db, w.root, ID)
  const sent: string[] = []
  const wire = watched(sent, w.root, ID, () => { throw new Error('schedule only: github is never asked for runs') })
  await atBatch(w, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(sent).toEqual([])
  expect(w.db.prepare("SELECT outcome, step FROM verdicts WHERE plan = ? AND rail_id = 'ci-green'").get(ID))
    .toEqual({ outcome: 'pass', step: 6 })
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = ? AND rail_id = 'ready'").get(ID))
    .toEqual({ outcome: 'pass' })
  expect(w.db.prepare('SELECT fork_ci_green FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .toEqual({ fork_ci_green: 1 })
})

test('main moving at batch rewinds, then lands fast-forward', async () => {
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

test('conflict at batch: back to rails, merge aborted, none closed', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(refused).toMatchObject({ step: 7, outcome: 'pass', spans: ['base:conflict'] })
  expect(plan(w.db, ID).step).toBe(3)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE who = 'gates'").get()).toEqual({ n: 0 })
  expect(w.db.prepare('SELECT state FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .not.toEqual({ state: 'pushed' })
})

test('main moving mid-tick makes the land a refusal, not a merge', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await atBatch(w, wire)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', BRANCH])
  moveMain(w.root, 'racing.ts')
  w.db.prepare("UPDATE plans SET lane = 'atelier' WHERE id = ?").run(ID)

  const refused = land(w.db, w.root, plan(w.db, ID), 1, wire)
  expect(refused).toMatchObject({ outcome: 'refuse', spans: ['base:stale'] })
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['rev-parse', BRANCH])).toBe(head)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(w.db.prepare("SELECT count(*) AS n FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(ID))
    .toEqual({ n: 0 })
})

test('behind main twice: rails merge it again', async () => {
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
  const again = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(again).toMatchObject({ step: 6, outcome: 'pass', spans: ['base:stale'] })
  expect(plan(w.db, ID).step).toBe(3)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, ID).step).toBe(6)
  expect(git(srcDir(w.root, ID), ['log', '--oneline', BRANCH])).toContain('main moves on second.ts')
  expect(headOf(w.root, ID).branch).toBe(BRANCH)
})

test('behind main past the lap cap: refused', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  put(w.root, ID, 'base.merged', 'x\n')
  put(w.root, ID, 'base.laps', 'base:stale\n'.repeat(LAPS))
  moveMain(w.root, 'late.ts')
  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 6, outcome: 'refuse', spans: ['base:stale'] })
  expect(refused?.note).toContain('have not caught main up')
})

test('a stale tree merges main at the rails and records the base', async () => {
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
  expect(git(srcDir(w.root, ID), ['log', '-1', '--format=%ae %ce', 'HEAD']))
    .toBe('cf@caliperforge.dev cf@caliperforge.dev')
  const row = lastMerge(w.db, ID)
  expect(row?.incoming).toEqual(['ahead.ts'])
  expect(row?.mine).toEqual(['src/hello.ts'])
  expect(row?.overlap).toBe(false)
  expect(row?.main).toBe(git(srcDir(w.root, ID), ['rev-parse', MAIN]))
})

test('a tree at main\'s head gains no commit at the rails', async () => {
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

test('a rails conflict aborts and hands back its paths, no retry', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  const src = srcDir(w.root, ID)
  const base = get(w.root, ID, 'base.sha')
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, retries: 0 })
  expect(cloned(src)).toBe(false)
  expect(maybe(w.root, ID, 'base.sha')).toBeNull()
  expect(base).not.toBe('')
  expect(get(w.root, ID, CARRY)).toContain('export const landed = true')
  expect(get(w.root, ID, 'refusal.md')).toContain('src/hello.ts')
  const row = lastMerge(w.db, ID)
  expect(row?.incoming).toEqual(['src/hello.ts'])
  expect(row?.mine).toEqual(['src/hello.ts'])
  expect(row?.overlap).toBe(true)
})

test('the re-cut checkout is main\'s, with the diff to re-apply', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  const src = srcDir(w.root, ID)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)

  const seen: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (packet) => seen.push(packet)), undefined, undefined, wire)

  expect(git(src, ['rev-parse', 'HEAD'])).toBe(git(src, ['rev-parse', MAIN]))
  expect(get(w.root, ID, 'base.sha').trim()).toBe(git(src, ['rev-parse', MAIN]))
  expect(seen[0]?.prompt).toContain('Re-apply this diff onto them')
  expect(seen[0]?.prompt).toContain('export const landed = true')
  expect(seen[0]?.prompt).toContain('main took this line')
  expect(carried(w.root, ID)).toContain('export const landed = true')
  built(w.root, ID, 'export const landed = true')

  expect(carried(w.root, ID)).toBeNull()
  expect(maybe(w.root, ID, CARRY)).not.toBeNull()
  expect(diffOf(w.root, ID)).toContain('export const landed = true')
  expect(diffOf(w.root, ID)).toContain('main took this line')
})

test('a re-cut after push folds in the pushed head', async () => {
  const w = mine()
  const wire = { ...watched([], w.root, ID), send: WIRE.send }
  await atBatch(w, wire)
  const remote = join(w.root, 'remotes', SELF)
  const old = git(remote, ['rev-parse', BRANCH])
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  const src = srcDir(w.root, ID)
  const tree = git(src, ['rev-parse', `${headOf(w.root, ID).sha}^{tree}`])
  expect(() => git(src, ['push', 'origin', BRANCH])).toThrow()

  const { head } = sent(w.root, plan(w.db, ID), SELF, WIRE)
  expect(git(remote, ['rev-parse', BRANCH])).toBe(git(src, ['rev-parse', 'HEAD']))
  expect(head.sha).toBe(git(src, ['rev-parse', 'HEAD']))
  expect(() => git(src, ['merge-base', '--is-ancestor', old, 'HEAD'])).not.toThrow()
  expect(git(src, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
  expect(sent(w.root, plan(w.db, ID), SELF, WIRE).head.sha).toBe(head.sha)
})

/**
 * The conflict loop had a counter, and what it counted was removed. The same conflict cannot
 * come round a second time now, because the second lap is not on the old base -- it is on main. The
 * repeat rule itself is the refusals ledger's, and is proved there (`store/refusals.test.ts`); what is
 * proved here is that the lap the counter existed for no longer happens.
 */
test('a conflict comes round once: the next lap is on main', async () => {
  const w = mine()
  const wire = watched([], w.root, ID)
  await atRails(w, wire)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'running', retries: 0 })
  expect(w.db.prepare('SELECT count(*) AS n FROM refusals WHERE plan = ? AND blip = 0').get(ID)).toEqual({ n: 1 })

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass', state: 'running' })
  expect(plan(w.db, ID).state).toBe('running')
  expect(w.db.prepare('SELECT count(*) AS n FROM refusals WHERE plan = ? AND blip = 0').get(ID)).toEqual({ n: 1 })
})

test('a tree stopped mid-merge commits no conflict marker', async () => {
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
  expect(cloned(src)).toBe(false)
  expect(get(w.root, ID, CARRY)).not.toContain('<<<<<<<')
  expect(diffOf(w.root, ID)).not.toContain('<<<<<<<')

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(conflicted(src)).toBe(false)
  expect(git(src, ['log', '-p', BRANCH])).not.toContain('<<<<<<<')
})

test('a target\'s tree at the rails ignores our own main moving', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  await atRails(w, wire, 1)
  ours(w.root)
  moveMain(w.root, 'ahead.ts')
  const src = srcDir(w.root, 1)
  const tree = git(src, ['rev-parse', `${git(src, ['stash', 'create'])}^{tree}`])
  const base = get(w.root, 1, 'base.sha')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(git(src, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
  expect(get(w.root, 1, 'base.sha')).toBe(base)
})

test('a seat works in its checkout and nowhere else in our tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-live-'))
  expect(liveTree(root, root)).toBe(true)
  expect(liveTree(root, join(root, 'store'))).toBe(true)
  expect(liveTree(root, join(root, '.cf/work'))).toBe(true)
  expect(liveTree(root, srcDir(root, 2))).toBe(false)
  expect(liveTree(root, join(srcDir(root, 2), 'store'))).toBe(false)
  expect(liveTree(root, tmpdir())).toBe(false)
})
