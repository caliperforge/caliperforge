import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet } from '../../providers/kind.ts'
import { gatesSigned, headApproved } from '../../store/approvals.ts'
import { deliverablesOf, newest } from '../../store/deliverables.ts'
import { ofKind } from '../../store/events.ts'
import { last as lastMerge } from '../../store/merges.ts'
import { dropPlan, relane } from '../../store/plans.ts'
import { refusalsOf } from '../../store/refusals.ts'
import { verdictRows } from '../../store/verdict.ts'
import { tick } from '../index.ts'
import { LAPS } from '../merge.ts'
import { COMMIT, commitMessage, headOf, land, sent, WIRE, type Wire } from '../push.ts'
import { CARRY, carried, cloned, conflicted, diffOf, drop, fetchMain, get, liveTree, maybe, MAIN, put, SELF, srcDir } from '../workspace.ts'
import { SCHEDULED } from './bases.ts'
import { approve, built, CARRIED, internalPlan, moveMain, once, ours, PASS, plan, stub, TYPESCRIPT, watched, world, type World } from './world.ts'

const ID = 2
const BRANCH = 'p2-let-an-internal-plan-run'
const FORKED = `send src ${BRANCH}`

const MESSAGE = 'let an internal plan run\n\nadd `hello()`.\n\nthe ask asks for it.\n\nCloses caliperforge/caliperforge#34\nPlan 2'

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const bodies = (cwd: string, range: string): string[] =>
  git(cwd, ['log', '--no-merges', '--format=%B%x00', range]).split('\0').map((m) => m.trim()).filter((m) => m !== '')

const rail = (w: World, id: string) => verdictRows(w.db, ID).find((v) => v.rail_id === id)

function mine(files: Record<string, string> = TYPESCRIPT, ci = true): World {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root, files, ci)
  internalPlan(w.db, w.root, ID)
  return w
}

/** Steps 0 to 2: the plan is on the rails step with the builder's bytes in the tree, uncommitted. */
async function atRails(w: World, wire: Wire, id = ID): Promise<void> {
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, id, 'export const landed = true')
}

/** Steps 3 to 6: step 6 sends the branch to the fork. */
async function toBatch(w: World, wire: Wire): Promise<void> {
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
}

const FRESH = once(() => world())
/** Our own plan, queued on our own repo. */
const MINE = once(() => mine())
const AT_RAILS = once(async () => {
  const w = await MINE()
  await atRails(w, watched([], w.root, ID))
  return w
})
/** AT_RAILS through step 6, its branch sent to the fork, with a copy of what was sent while it was built. */
const AT_BATCH = ((): (() => Promise<{ w: World; sent: string[] }>) => {
  const sent: string[] = []
  const made = once(async () => {
    const w = await AT_RAILS()
    await toBatch(w, watched(sent, w.root, ID))
    return w
  })
  return async () => ({ w: await made(), sent: [...sent] })
})()
/** MINE ticked to step 6 with no builder bytes. */
const AT_FORK = once(async () => {
  const w = await MINE()
  const wire = watched([], w.root, ID)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  return w
})

/** Our own plan on `files`, whose repo runs no workflow on push, at step 7, with a copy of what was sent while it was built. */
const unrun = (files: Record<string, string>): (() => Promise<{ w: World; sent: string[] }>) => {
  const sent: string[] = []
  const made = once(async () => {
    const w = mine(files, false)
    const wire = watched(sent, w.root, ID, () => { throw new Error('no workflow runs: github is never asked for runs') })
    await atRails(w, wire)
    await toBatch(w, wire)
    return w
  })
  return async () => ({ w: await made(), sent: [...sent] })
}

test('past ready, the next tick lands, pushes and closes',async () => {
  const w = await AT_RAILS()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await toBatch(w, wire)
  expect(plan(w.db, ID).step).toBe(7)
  expect(sent).toEqual([FORKED])
  expect(rail(w, 'ci-green')).toMatchObject({ outcome: 'pass', step: 6 })

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  const sha = git(src, ['rev-parse', 'main'])
  expect(fired).toMatchObject({ step: 7, name: 'batch', outcome: 'pass', state: 'running' })
  expect(fired?.note).toBe(`landed ${BRANCH} on main as ${sha.slice(0, 12)}`)
  expect(sha).toBe(git(src, ['rev-parse', BRANCH]))
  expect(sent).toEqual([FORKED, 'send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
  expect(newest(w.db, ID)).toMatchObject({ state: 'pushed', evidence: `https://github.com/caliperforge/caliperforge/commit/${sha}` })
  expect(headApproved(w.db, sha)).toBe(true)

  const last = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(last).toMatchObject({ step: 8, name: 'push', outcome: 'pass', state: 'done' })
  expect(sent).toHaveLength(3)
})

test('landed commits carry title, what, why, closes, plan',async () => {
  const { w } = await AT_BATCH()
  const wire = watched([], w.root, ID)
  expect(rail(w, 'ci-green')).toMatchObject({ outcome: 'pass', step: 6 })
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(new Set(bodies(srcDir(w.root, ID), `${MAIN}..main`))).toEqual(new Set([MESSAGE]))
})

test('round two adds a same-message commit atop the first',async () => {
  const w = await AT_RAILS()
  const first = headOf(w.root, ID).sha
  built(w.root, ID, 'export const again = true')
  headOf(w.root, ID)
  const src = srcDir(w.root, ID)
  expect(bodies(src, `${MAIN}..HEAD`)).toEqual([MESSAGE, MESSAGE])
  expect(git(src, ['rev-parse', 'HEAD~1'])).toBe(first)
})

test('a bare upstream number stays out of the message',async () => {
  const w = await MINE()
  put(w.root, ID, 'issue.md', '# let #35 run\n\n**What:** add it.\n**Why:** #35 asks for it.\n')
  const message = commitMessage(w.root, plan(w.db, ID))
  expect(message).toBe('let run\n\nadd it.\n\nasks for it.\n\nCloses caliperforge/caliperforge#34\nPlan 2')
})

test('no saved message commits under the branch name',async () => {
  const w = await AT_RAILS()
  drop(w.root, ID, COMMIT)
  headOf(w.root, ID)
  expect(bodies(srcDir(w.root, ID), `${MAIN}..HEAD`)).toEqual([BRANCH])
})

test('a loupe plan installs once, after send and close',async () => {
  const w = await AT_RAILS()
  const sent: string[] = []
  const wire = watched(sent, w.root, ID)
  await toBatch(w, wire)
  relane(w.db, ID, 'loupe')

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const sha = git(srcDir(w.root, ID), ['rev-parse', 'main'])
  expect(sent).toEqual([FORKED, 'send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`, 'install'])
})

test.each([
  { base: 'no workflows', made: unrun(TYPESCRIPT) },
  { base: 'schedule or manual workflows', made: unrun(SCHEDULED) },
])('$base: lands on step 3\'s checks, no fork run', async ({ made }) => {
  const { w, sent } = await made()
  const wire = watched(sent, w.root, ID, () => { throw new Error('no workflow runs: github is never asked for runs') })
  expect(plan(w.db, ID).step).toBe(7)
  expect(sent).toEqual([])
  expect(rail(w, 'ci-green')).toMatchObject({ outcome: 'pass', step: 6 })
  expect(rail(w, 'ready')).toMatchObject({ outcome: 'pass' })
  expect(newest(w.db, ID)?.fork_ci_green).toBe(1)

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const sha = git(srcDir(w.root, ID), ['rev-parse', 'main'])
  expect(sent).toEqual(['send src main', `close caliperforge/caliperforge#34 ${sha.slice(0, 7)}`])
})

test('main moving before batch rewinds, lands on pass two',async () => {
  const { w, sent } = await AT_BATCH()
  const wire = watched(sent, w.root, ID)
  moveMain(w.root, 'after.ts')

  const held = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(held).toMatchObject({ step: 7, outcome: 'pass', state: 'running', spans: ['base:stale'] })
  expect(plan(w.db, ID).step).toBe(3)
  expect(sent).toEqual([FORKED])
  expect(gatesSigned(w.db)).toBe(0)
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

test('conflict at batch: back to rails, aborted, nothing closed',async () => {
  const { w, sent } = await AT_BATCH()
  const wire = watched(sent, w.root, ID)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  const src = srcDir(w.root, ID)
  expect(refused).toMatchObject({ step: 7, outcome: 'pass', spans: ['base:conflict'] })
  expect(plan(w.db, ID).step).toBe(3)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['diff', '--name-only', '--diff-filter=U'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(gatesSigned(w.db)).toBe(0)
  expect(newest(w.db, ID)?.state).not.toBe('pushed')
})

test('a merge git refuses with no unmerged path logs it',async () => {
  const { w, sent } = await AT_BATCH()
  const wire = watched(sent, w.root, ID)
  const src = srcDir(w.root, ID)
  mkdirSync(join(w.root, 'hooks'), { recursive: true })
  writeFileSync(join(w.root, 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  moveMain(w.root, 'late.ts')

  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 7, outcome: 'pass', spans: ['base:conflict'] })
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(ofKind(w.db, 'swallowed')).toMatchObject([{ plan: ID, actor: 'takeMain' }])
})

test('main moving mid-tick refuses the land, no merge commit',async () => {
  const { w, sent } = await AT_BATCH()
  const wire = watched(sent, w.root, ID)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', BRANCH])
  moveMain(w.root, 'racing.ts')
  relane(w.db, ID, 'loupe')

  const refused = land(w.db, w.root, plan(w.db, ID), 1, wire)
  expect(refused).toMatchObject({ outcome: 'refuse', spans: ['base:stale'] })
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['rev-parse', BRANCH])).toBe(head)
  expect(git(src, ['status', '--porcelain'])).toBe('')
  expect(sent).toEqual([FORKED])
  expect(deliverablesOf(w.db, ID).filter((d) => d.state === 'pushed')).toEqual([])
})

test('main moving during the push refuses base:stale',async () => {
  const { w, sent } = await AT_BATCH()
  const wire = watched(sent, w.root, ID)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', BRANCH])
  const racing = { ...wire, send: (dir: string) => { moveMain(w.root, 'racing.ts'); git(dir, ['push', 'origin', 'main']) } }

  expect(land(w.db, w.root, plan(w.db, ID), 1, racing)).toMatchObject({ outcome: 'refuse', spans: ['base:stale'] })
  expect(sent.filter((s) => s.startsWith('close'))).toEqual([])
  expect(deliverablesOf(w.db, ID).filter((d) => d.state === 'pushed')).toEqual([])
  expect(git(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)
  expect(git(src, ['rev-parse', BRANCH])).toBe(head)
  expect(git(src, ['status', '--porcelain'])).toBe('')
})

test('a failed push with main unmoved still throws',async () => {
  const { w } = await AT_BATCH()
  const wire = watched([], w.root, ID)
  const hung = { ...wire, send: () => { throw new Error('remote hung up') } }

  expect(() => land(w.db, w.root, plan(w.db, ID), 1, hung)).toThrow('remote hung up')
})

test('behind main twice: rails merge it again', async () => {
  const w = await AT_FORK()
  const wire = watched([], w.root, ID)
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
  const w = await AT_FORK()
  const wire = watched([], w.root, ID)
  put(w.root, ID, 'base.merged', 'x\n')
  put(w.root, ID, 'base.laps', 'base:stale\n'.repeat(LAPS))
  moveMain(w.root, 'late.ts')
  const refused = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(refused).toMatchObject({ step: 6, outcome: 'refuse', spans: ['base:stale'] })
  expect(refused?.note).toContain('have not caught main up')
})

test('a stale tree merges main and records its base in one tick',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
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

test('a tree at main\'s head keeps its head and base.sha',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
  const src = srcDir(w.root, ID)
  const head = git(src, ['rev-parse', 'HEAD'])
  const base = get(w.root, ID, 'base.sha')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass' })
  expect(git(src, ['rev-parse', 'HEAD'])).toBe(head)
  expect(get(w.root, ID, 'base.sha')).toBe(base)
})

test('a rails conflict aborts and hands back paths, no retry',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
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

test('the re-cut is main\'s; the builder re-applies its diff',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
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

test('a re-cut keeps the pushed head, so the push fast-forwards',async () => {
  const w = await AT_RAILS()
  const wire = { ...watched([], w.root, ID), send: WIRE.send }
  await toBatch(w, wire)
  const remote = join(w.root, 'remotes', SELF)
  const old = git(remote, ['rev-parse', BRANCH])
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  built(w.root, ID, 'export const landed = true')
  const src = srcDir(w.root, ID)
  const tree = git(src, ['rev-parse', `${headOf(w.root, ID).sha}^{tree}`])
  expect(() => git(src, ['push', 'origin', BRANCH])).toThrow()

  const { head } = sent(w.db, w.root, plan(w.db, ID), SELF, WIRE)
  expect(git(remote, ['rev-parse', BRANCH])).toBe(git(src, ['rev-parse', 'HEAD']))
  expect(head.sha).toBe(git(src, ['rev-parse', 'HEAD']))
  expect(() => git(src, ['merge-base', '--is-ancestor', old, 'HEAD'])).not.toThrow()
  expect(git(src, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
  expect(sent(w.db, w.root, plan(w.db, ID), SELF, WIRE).head.sha).toBe(head.sha)
})

/**
 * The same conflict cannot come round a second time, because the second lap is not on the old base --
 * it is on main. The repeat rule itself is the refusals ledger's, and is proved there (`store/refusals.test.ts`).
 */
test('a conflict does not repeat: the next lap is on main',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
  moveMain(w.root, 'src/hello.ts', 'export const hello = (): string => "main took this line"\n')

  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'refuse', spans: ['src/hello.ts'] })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'running', retries: 0 })
  expect(refusalsOf(w.db, ID)).toBe(1)

  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
    .toMatchObject({ step: 3, outcome: 'pass', state: 'running' })
  expect(plan(w.db, ID).state).toBe('running')
  expect(refusalsOf(w.db, ID)).toBe(1)
})

test('a tree stopped mid-merge commits no conflict marker',async () => {
  const w = await AT_RAILS()
  const wire = watched([], w.root, ID)
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

test('a target\'s tree is untouched when our own main moves',async () => {
  const w = await FRESH()
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

test('a seat works in the plan checkout and nowhere else',() => {
  const root = mkdtempSync(join(tmpdir(), 'cf-live-'))
  expect(liveTree(root, root)).toBe(true)
  expect(liveTree(root, join(root, 'store'))).toBe(true)
  expect(liveTree(root, join(root, '.cf/work'))).toBe(true)
  expect(liveTree(root, srcDir(root, 2))).toBe(false)
  expect(liveTree(root, join(srcDir(root, 2), 'store'))).toBe(false)
  expect(liveTree(root, tmpdir())).toBe(false)
})
