import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { headApproved } from '../../store/approvals.ts'
import { tick } from '../index.ts'
import { headOf, type Wire } from '../push.ts'
import { liveTree, srcDir } from '../workspace.ts'
import { approve, built, CARRIED, forkCi, internalPlan, moveMain, ours, plan, ready, stub, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

function watched(log: string[]): Wire {
  return {
    send: (dir, branch) => void log.push(`send ${basename(dir)} ${branch}`),
    open: (repo, head) => { log.push(`open ${repo} ${head}`); return 'https://github.com/x/y/pull/1' },
    close: (repo, no, sha) => void log.push(`close ${repo}#${String(no)} ${sha.slice(0, 7)}`),
  }
}

/** Steps 0 to 6: the builder's bytes land at step 2, and the one ready proof no step writes at step 5. */
async function atBatch(w: World, wire: Wire): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  forkCi(w.db, ID)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

test('an internal plan that passed ready is on main, pushed and its issue closed, in the next tick', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent)
  await atBatch(w, wire)
  expect(plan(w.db, ID).step).toBe(7)

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  const sha = git(src, ['rev-parse', 'main'])
  expect(fired).toMatchObject({ step: 7, name: 'batch', outcome: 'pass', state: 'running' })
  expect(fired?.note).toBe(`landed ${BRANCH} on main as ${sha.slice(0, 12)}`)
  expect(sha).toBe(git(src, ['rev-parse', BRANCH]))
  expect(sent).toEqual(['send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
  expect(w.db.prepare('SELECT state, evidence FROM deliverables WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(ID))
    .toEqual({ state: 'pushed', evidence: `https://github.com/caliperforge/caliperforge/commit/${sha}` })
  expect(headApproved(w.db, sha)).toBe(true)

  const last = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(last).toMatchObject({ step: 8, name: 'push', outcome: 'pass', state: 'done' })
  expect(sent).toHaveLength(2)
})

test('main moving between ready and batch lands a merge commit the gates sign too', async () => {
  const w = mine()
  const sent: string[] = []
  const wire = watched(sent)
  await atBatch(w, wire)
  moveMain(w.root, 'after.ts')

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const src = srcDir(w.root, ID)
  const sha = git(src, ['rev-parse', 'main'])
  expect(git(src, ['rev-list', '--parents', '-n', '1', 'main']).split(' ')).toHaveLength(3)
  expect(sha).not.toBe(git(src, ['rev-parse', BRANCH]))
  expect(headApproved(w.db, sha)).toBe(true)
  expect(headApproved(w.db, git(src, ['rev-parse', BRANCH]))).toBe(true)
})

test('an external plan does not land: step 7 still waits for the ceo and step 8 opens a pull request', async () => {
  const w = world()
  const sent: string[] = []
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent))
  ready(w.db, 1)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent))

  expect(plan(w.db, 1).step).toBe(7)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent)))[0]).toBeUndefined()
  expect(sent).toEqual([])
  expect(w.db.prepare("SELECT count(*) AS n FROM approvals WHERE who = 'gates'").get()).toEqual({ n: 0 })
  expect(git(srcDir(w.root, 1), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('widget-12-a1')
})

test('a base behind main merges main and re-runs the rails once, then refuses on the second miss', async () => {
  const w = mine()
  const wire = watched([])
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  forkCi(w.db, ID)
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
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
