import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { measure, type Read } from '../../cli/measure.ts'
import { account, parse, refuseTarget } from '../../cli/queue.ts'
import { addPipe, advance, allPlans, clock, dropPlan, end, inWindow, laneOff, overlapWaits, parked, pipeNamed, requeue, rewind, underCap, waiting, type PipeRow, type PlanRow, type Wait } from '../../store/plans.ts'
import { amend, width } from '../../store/lanes.ts'
import { holdOf, retried } from '../../store/holds.ts'
import { current } from '../../store/now.ts'
import { clear } from '../../store/refusals.ts'
import { dropDeliverables, pushedRow } from '../../store/deliverables.ts'
import { gates } from '../../store/approvals.ts'
import { addTarget, setTargetState, targetRow } from '../../store/targets.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { picks } from '../next.ts'
import { blocked, kernel } from '../steps.ts'
import { checkout, diffOf, doneIds, get, gitDiff, narrowing, put, snapshot, srcDir } from '../workspace.ts'
import { GREEN } from '../base.ts'
import { record } from '../../store/files.ts'
import { eventsOf, newestMode, runRows } from '../../store/events.ts'
import { overrule, verdictRows } from '../../store/verdict.ts'
import { record as signal } from '../../store/signals.ts'
import { benchPacket } from '../../runner/packet.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import type { Gh } from '../../rails/ci-green/index.ts'
import type { Fired } from '../kind.ts'
import { forkCi, type Wire } from '../push.ts'
import { approve, builds, built, CARRIED, dropping, internalPlan, KOTLIN, ours, owning, PASS, plan, REFUSE, rerunning, RUN, runsAfter, runsOn, scored, stub, tip, watched, WORDS, world, type World } from './world.ts'

const head = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0,
    head_digest: null, priority: 1, lane: null, seat: null, origin: null, wait_reason: null, ...over })

test('outside seat on a stranger\'s repo writes only brief files', async () => {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  const builder = packets.find((p) => p.tools.includes('Write'))
  expect(builder?.prompt).toContain('# outside_specialist')
  expect(builder?.prompt).toContain('# Symbols at the branch base\n\nEach top-level export at the branch base, as path:line name.\n\nsrc/hello.ts:1 hello\n')
  const src = realpathSync(srcDir(w.root, 1))
  expect(builder?.cwd).toBe(srcDir(w.root, 1))
  expect(builder?.refuse(join(src, 'src/hello.ts'))).toBeNull()
  expect(builder?.refuse('src/nested/hello.ts')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse(join(src, 'README.md'))).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse(join(src, '../issue.md'))).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse('../hello.ts')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('a target plan clones our fork, branching off upstream main', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const src = srcDir(w.root, 1)
  expect(existsSync(join(src, 'src/hello.ts'))).toBe(true)
  expect(head(src, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('widget-12-a1')
  expect(head(src, ['remote', 'get-url', 'origin'])).toMatch(/remotes\/caliperforge\/widget$/)
  expect(head(src, ['remote', 'get-url', 'upstream'])).toMatch(/remotes\/acme\/widget$/)
  expect(head(src, ['rev-parse', 'HEAD'])).toBe(readFileSync(join(w.root, '.cf/work/1/base.sha'), 'utf8').trim())
  expect(head(src, ['status', '--porcelain'])).toBe('')
  expect(readFileSync(join(src, '.git/info/exclude'), 'utf8')).toContain('.cf-derived/')
})

const PYC = 'pkg/__pycache__/m.cpython-312.pyc'

const pytested = (): { dir: string; base: string; root: string } => {
  const w = world()
  const { dir, base } = checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  mkdirSync(join(dir, 'pkg/__pycache__'), { recursive: true })
  writeFileSync(join(dir, 'pkg/m.py'), 'x = 1\n')
  writeFileSync(join(dir, PYC), 'compiled')
  return { dir, base, root: w.root }
}

test('D2 a .pyc a test run wrote after the cut is not in the diff', () => {
  const { dir, base } = pytested()
  const diff = gitDiff(dir, base)
  expect(diff).toContain('pkg/m.py')
  expect(diff).not.toContain('.pyc')
})

test('D3 a reused checkout drops an intent-to-add .pyc, keeps .py', () => {
  const { dir, base, root } = pytested()
  head(dir, ['add', '-f', '--intent-to-add', PYC])
  head(dir, ['add', 'pkg/m.py'])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  expect(head(dir, ['ls-files', '--', PYC])).toBe('')
  expect(head(dir, ['diff', '--cached', '--name-only'])).toBe('pkg/m.py')
  expect(gitDiff(dir, base)).not.toContain('.pyc')
})

test('D4 a __pycache__ file HEAD holds stays in the index', () => {
  const { dir, root } = pytested()
  head(dir, ['add', '-f', PYC])
  head(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked pyc'])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  expect(head(dir, ['ls-files', '--', PYC])).toBe(PYC)
})

const CACHE = 'kotlin/.gradle/9.7.1/gc.properties'
const JAR = 'kotlin/build/libs/a.jar'

const gradled = (): { dir: string; base: string; root: string } => {
  const w = world()
  const { dir, base } = checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  mkdirSync(join(dir, 'kotlin/.gradle/9.7.1'), { recursive: true })
  mkdirSync(join(dir, 'kotlin/build/libs'), { recursive: true })
  writeFileSync(join(dir, 'kotlin/Main.kt'), 'fun main() {}\n')
  writeFileSync(join(dir, CACHE), 'gc')
  writeFileSync(join(dir, JAR), 'jar')
  return { dir, base, root: w.root }
}

test('D2 Gradle cache and build output are not in the diff', () => {
  const { dir, base } = gradled()
  const diff = gitDiff(dir, base)
  expect(diff).toContain('kotlin/Main.kt')
  expect(diff).not.toContain('.gradle')
  expect(diff).not.toContain('kotlin/build')
})

test('D3 a reused checkout drops an intent-to-add .gradle file', () => {
  const { dir, base, root } = gradled()
  head(dir, ['add', '-f', '--intent-to-add', CACHE])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  expect(head(dir, ['ls-files', '--', CACHE])).toBe('')
  expect(gitDiff(dir, base)).not.toContain('.gradle')
})

test('D4 a build/ file HEAD holds stays in the index', () => {
  const { dir, root } = gradled()
  head(dir, ['add', '-f', JAR])
  head(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked jar'])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  expect(head(dir, ['ls-files', '--', JAR])).toBe(JAR)
})

test('a kotlin/ brief builds on the kotlin seat, diffed at base', async () => {
  const w = world('warm', undefined, KOTLIN)
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  record(w.db, 1, [{ path: 'kotlin/build.gradle.kts', is_new: false }])
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
  expect(fired?.note).toMatch(/^kotlin_specialist /)
  expect(existsSync(join(srcDir(w.root, 1), 'kotlin/build.gradle.kts'))).toBe(true)
  const seen: Packet[] = []
  const bin = mkdtempSync(join(tmpdir(), 'cf-bin-'))
  writeFileSync(join(bin, 'gradle'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path ?? ''}`
  const gated = await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
    .finally(() => { process.env.PATH = path })
  expect(gated[0]).toMatchObject({ step: 3, outcome: 'pass', note: 'pre-review: six rails pass; checks ran kotlin' })
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p)))
  expect(seen[0]?.prompt.split('# Diff')[1]?.trim())
    .toBe('# Checks that ran\n\n- kotlin | kotlin | gradle installDist test | pass')
})

test('D1 D2 a firing seat holds a now row the lap clears', async () => {
  const w = world()
  approve(w.db, w.target)
  await tick(w.db, w.root, stub(CARRIED))
  const during: unknown[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, () => during.push(...current(w.db).map(({ doing, detail, pid }) => ({ doing, detail, pid })))))
  expect(during).toEqual([{ doing: 'model', detail: 'brief_writer step 1', pid: process.pid }])
  expect(current(w.db)).toEqual([])
})

test('a pipe fires only in its window, wrapping across midnight', () => {
  expect(clock(new Date('2026-09-17T15:05:00Z'), -360)).toBe('09:05')
  expect(clock(new Date('2026-09-17T15:05:00Z'))).toBe('15:05')
  expect(inWindow(pipe({}), '09:00')).toBe(true)
  expect(inWindow(pipe({}), '08:59')).toBe(false)
  expect(inWindow(pipe({ window_start: '22:00', window_end: '02:00' }), '23:30')).toBe(true)
  expect(inWindow(pipe({ window_start: '22:00', window_end: '02:00' }), '12:00')).toBe(false)
})

test('a pipe at max_concurrent offers only running plans', () => {
  const plans = [row({ id: 1, state: 'running' }), row({ id: 2, state: 'queued' })]
  expect(underCap(pipe({ max_concurrent: 1 }), plans).map((p) => p.id)).toEqual([1])
  expect(underCap(pipe({ max_concurrent: 2 }), plans).map((p) => p.id)).toEqual([1, 2])
})

test('an off pipe fires nothing', async () => {
  const w = world()
  laneOff(w.db, w.pipe.id)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
})

test('step 1 waits on cf approve target, and the plan says so', async () => {
  const w = world()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).step).toBe(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_approval')
  approve(w.db, w.target)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
})

test('D6: a refused target digest still blocks step 1', async () => {
  const w = world()
  await tick(w.db, w.root, stub(CARRIED))
  refuseTarget(w.db, w.target, 'not.ours', 'coo')
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_approval')
})

test('D8: a tick files no plan for an unapproved ready target', async () => {
  const w = world()
  const id = addTarget(w.db, { ...targetRow(w.db, 1), issue_no: 13, state: 'ready', evidence: 'https://github.com/acme/widget/issues/13' })
  await tick(w.db, w.root, stub(CARRIED))
  expect(allPlans(w.db).filter((p) => p.target_id === id)).toEqual([])
})

test('a parked target holds its plan; a cold pulse alone does not', async () => {
  const w = world('cold')
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_parked')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_parked')
  setTargetState(w.db, 1, 'ready')
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('#140: the store takes only the reasons it lists', () => {
  const w = world('cold')
  expect(() => { waiting(w.db, [{ plan: 1, why: 'because i said so' as Wait }]) }).toThrow(/CHECK constraint/)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('stale account evidence holds nothing; cf queue add measures', () => {
  const w = world('warm', '2026-01-01')
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect(() => account(w.db, 'acme/widget', '2026-09-17')).toThrow(/re-measure before queueing/)
  expect(() => account(w.db, 'acme/other', '2026-09-17')).toThrow(/no accounts row/)
})

/** The three `gh` shapes `cf measure` parses, canned: one outsider merge that day, one open pr, one other repo. */
const measured = (day: string): Read => (args) => {
  if (args[0] === 'search') return [{ repository: { nameWithOwner: 'acme/other' } }]
  if (args.includes('createdAt,headRepositoryOwner')) return [{ createdAt: `${day}T00:00:00Z`, headRepositoryOwner: null }]
  return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: `${day}T00:00:00Z` }]
}

test('cf measure refreshes the pulse the tick reads', async () => {
  const w = world('warm', '2026-01-01')
  approve(w.db, w.target)
  expect(measure(w.db, 'acme/widget', '2026-09-17', measured('2026-09-17'))).toMatchObject({ pulse: 'warm', doors: 1 })
  expect(targetRow(w.db, 1).account_id).toBe(1)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect((await tick(w.db, w.root, stub(CARRIED), new Date('2026-09-17T09:00:00Z')))[0]?.step).toBe(0)
  expect(plan(w.db, 1).step).toBe(1)
})

test('a rail refusal names spans, steps back, then blocks on ceo', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2]) {
    expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]?.step).toBe(step)
  }
  const first = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(first).toMatchObject({ step: 3, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  await tick(w.db, w.root, stub(UNPOINTED))
  const stopped = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(stopped).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(holdOf(w.db, 1)).toEqual({ held_by: 'coo', held_why: stopped?.note })
  const verdict = verdictRows(w.db, 1).find((v) => v.rail_id === 'completion-audit')
  expect(verdict).toMatchObject({ outcome: 'refuse', origin_ref: 'completion-audit' })
})

const retriedOnce = async (rule: (w: World) => void): Promise<[World, Fired | undefined]> => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  rule(w)
  retried(w.db, 1, 'ceo')
  await tick(w.db, w.root, stub(UNPOINTED))
  return [w, (await tick(w.db, w.root, stub(UNPOINTED)))[0]]
}

test('D1 D2 the same refusal after a retry stops again', async () => {
  const [w, fired] = await retriedOnce(() => undefined)
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse', state: 'blocked_on_ceo' })
  expect(planFile(w.root, 'refusal.md')).toContain('# Stopped\n\nthe same refusal came back')
})

test('D2 a refusal repeated after an ask ruling goes round again', async () => {
  const [, fired] = await retriedOnce((w) => { put(w.root, 1, 'ask.md', `${get(w.root, 1, 'ask.md')}\n## Ruling\n\nuse bye()\n`) })
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse', state: 'retried' })
})

test('D4 a refusal repeated after rulings.md goes round again', async () => {
  const [, fired] = await retriedOnce((w) => { put(w.root, 1, 'rulings.md', 'use bye()\n'); built(w.root, 1, 'export const more = 1') })
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse', state: 'retried' })
})

test('the bench gets a maintainer view; bad shape refuses first', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2, 3]) {
    expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1)))[0]?.step).toBe(step)
  }
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 4, outcome: 'pass', state: 'running' })
  const row = verdictRows(w.db, 1).find((v) => v.step === 4)
  expect(row).toMatchObject({ gate: 'review', kind: 'review', outcome: 'pass' })
  const bare = benchPacket(w.root, 'code_quality', 'a handback is not a maintainer view', '/tmp/x.transcript.jsonl')
  expect(bare).toHaveProperty('refusal')
})

const planFile = (root: string, name: string): string => readFileSync(join(root, '.cf/work/1', name), 'utf8')

const PAIR = `${WORDS}\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n---\n`

test('a rebuild hands the builder the refused hand-back\'s rows', async () => {
  const w = world()
  approve(w.db, w.target)
  const sent: string[] = []
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(UNPOINTED), undefined, undefined, watched(sent, w.root, 1))
  expect(sent).toEqual([])
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  expect(planFile(w.root, 'step-2.handback.prev.md')).toBe(UNPOINTED)
  expect(packets.find((p) => p.tools.includes('Write'))?.prompt)
    .toContain('done:\n  - id: D1\n    status: done\n    pointer:')
})

test('a review refusal rebuilds with every span, then escalates', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, PAIR)))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', state: 'retried' })
  expect(fired?.spans).toEqual(['src/hello.ts:1', 'src/parse.ts:3'])
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md'))
    .toBe(`step 4 review refused by code_quality\n\ncode_quality refuse\n\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n\n${WORDS}\n`)
  expect(planFile(w.root, 'step-4.verdict.md'))
    .toBe(`---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n---\n\n${WORDS}\n`)

  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const second = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(second).toMatchObject({ step: 4, outcome: 'refuse', state: 'blocked_on_ceo' })
  expect(plan(w.db, 1)).toMatchObject({ step: 4, retries: 1, state: 'blocked_on_ceo' })
})

test('a review needs_ceo holds for the coo with its question', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, `${WORDS}\n\n---\noutcome: needs_ceo\n---\n`)))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'needs_ceo', state: 'blocked_on_ceo' })
  expect(holdOf(w.db, 1)).toEqual({ held_by: 'coo', held_why: `code_quality needs_ceo: ${WORDS}` })
  expect(w.db.prepare('SELECT message FROM verdicts WHERE plan = 1 AND step = 4').get()).toEqual({ message: WORDS })
})

test('a new refusal after a rebuild goes round; a repeat stops', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect((await tick(w.db, w.root, stub(CARRIED, 0, PAIR)))[0]).toMatchObject({ step: 4, state: 'retried' })
  built(w.root, 1, 'export const two = (): number => 2')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect((await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]).toMatchObject({ step: 4, state: 'retried' })
  built(w.root, 1, 'export const three = (): number => 3')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect((await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]).toMatchObject({ step: 4, state: 'blocked_on_ceo' })
  expect(planFile(w.root, 'refusal.md')).toContain('# Stopped\n\nthe same refusal came back')
})

/**
 * This round is on one of our own plans, not a stranger's:
 * an outside seat may write only the files the brief lists, full stop, so a second file it needs in
 * the diff cannot be owned there at all. On our own repository it can, under `## Outside the files`.
 */
const MINE = 2
const OWNS = owning(['src/parse.ts'])

/** The first reviewer packet of a round: a builder's carries Write, a reviewer's is Read only. */
const reviewer = (packets: Packet[]): string => packets.find((p) => !p.tools.includes('Write'))?.prompt ?? ''

test('outside reviewer gets context and map; ours does not', async () => {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  const inner = builds(() => { writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hello"\n') })
  const seen: Provider = { ...inner, fire: (p) => { packets.push(p); return inner.fire(p) } }
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, seen, undefined, undefined, watched([], w.root, 1))
  const prompt = packets.find((p) => p.prompt.includes('\n# Diff\n'))?.prompt ?? ''
  expect(prompt).toContain('# Changed code in context')
  expect(prompt).toContain('# Files around the change')
  expect(prompt.indexOf('# Changed code in context')).toBeGreaterThan(prompt.indexOf('# Diff'))
  expect(prompt).not.toContain('\n# Checks that ran\n')
  expect(prompt).toContain('# Symbols at the branch base\n\nEach top-level export at the branch base, as path:line name.\n\nsrc/hello.ts:1 hello\n')
  expect(prompt.indexOf('# Symbols at the branch base')).toBeGreaterThan(prompt.indexOf('# Files around the change'))
})

test('D3 an outside review packet has no hand-back', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const packets: Packet[] = []
  expect((await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p))))[0]).toMatchObject({ step: 4 })
  expect(reviewer(packets)).toContain('\n# Diff\n')
  expect(reviewer(packets)).not.toContain("# The builder's hand-back")
})

test('D3 our own plan builds and hands no symbol map', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  const seen: Packet[] = []
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, FOUR)
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p)))
  expect(plan(w.db, MINE).step).toBe(5)
  expect(seen.map((p) => p.prompt.includes('# Symbols at the branch base'))).toEqual([false, false])
  expect(existsSync(join(w.root, '.cf/maps'))).toBe(false)
})

test('a reviewer gets its last verdict and diff, not on its first', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(join(srcDir(w.root, MINE), 'src/parse.ts'), 'export const parse = (): number => 1\n')
  const round1: Packet[] = []
  await tick(w.db, w.root, stub(OWNS, 0, REFUSE, (p) => round1.push(p)))
  expect(reviewer(round1)).not.toContain('# Your last verdict')
  expect(reviewer(round1)).not.toContain('# Changed code in context')
  expect(reviewer(round1)).not.toContain('\n# Checks that ran\n')

  built(w.root, MINE, 'export const two = (): number => 2')
  const round2: Packet[] = []
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(OWNS, 0, PASS, (p) => round2.push(p)))
  const prompt = reviewer(round2)
  expect(prompt).not.toContain('\n# Checks that ran\n')
  expect(prompt).toContain(`# Your last verdict\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n---\n\n${WORDS}`)
  expect(prompt.split('# Changed since your last verdict')[1]).toContain('+export const two = (): number => 2')
  expect(prompt.split('# Paths since your last verdict')[1]).toMatch(
    new RegExp(`changed since the tree you judged:\n {2}- src/hello\\.ts\n\n`
      + `merged from main, not the builder's:\n {2}- none\n\n`
      + `unchanged since you judged it, at the blob it had then:\n {2}- src/parse\\.ts [0-9a-f]{40}`))
  const trees = verdictRows(w.db, MINE).filter((v) => v.step === 4)
  expect(trees).toHaveLength(2)
  expect(trees.every((r) => /^[0-9a-f]{40}$/.test(r.tree ?? ''))).toBe(true)
})

const HELLO = (word: string): string =>
  `export function hello(): string {\n  const a = "h"\n  const b = "i"\n  const c = ""\n  const d = ""\n  const word = ${word}\n  return word + c + d\n}\n`

const section = (prompt: string, head: string): string => prompt.split(`\n# ${head}\n\n`)[1]?.split('\n\n# ')[0] ?? ''

test('step 5 sent back gets its delta in function, with refusal', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  const hello = join(srcDir(w.root, MINE), 'src/hello.ts')
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(hello, HELLO('a + b'))
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE))
  const baseTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: srcDir(w.root, MINE), encoding: 'utf8' }).trim()
  overrule(w.db, MINE, 4, 'review.code_quality', baseTree)
  writeFileSync(hello, HELLO('a + b + "!"'))
  const seen: Packet[] = []
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, REFUSE, (p) => seen.push(p)))

  const prompt = reviewer(seen)
  expect(section(prompt, 'Diff')).toContain('\n+  const c = ""\n')
  expect(section(prompt, 'Your last verdict')).toMatch(/^---\noutcome: pass\n/)
  expect(section(prompt, 'Refusal that sent the build back')).toMatch(/^step 5 /)
  expect(section(prompt, 'Refusal that sent the build back')).toContain(WORDS)
  const since = section(prompt, 'Changed since your last verdict')
  expect(since).toContain('\n export function hello(): string {\n')
  expect(since).toContain('\n+  const word = a + b + "!"\n')
  expect(since).not.toContain('+  const c = ""')
  expect(section(prompt, 'Paths since your last verdict')).toContain('changed since the tree you judged:\n  - src/hello.ts\n')
})

const FOUR = 'export const one = 1\nexport const two = 2\nexport const three = 3\nexport const four = 4'

test('D2 our own step 4 runs typescript_specialist in review', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, FOUR)
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  expect(runRows(w.db).filter((r) => r.plan === MINE && r.step === 4).map((r) => r.seat)).toEqual(['typescript_specialist'])
  expect(newestMode(w.db)).toBe('review')
  expect(verdictRows(w.db, MINE).find((v) => v.step === 4)).toMatchObject({ gate: 'review', kind: 'review', outcome: 'pass' })
})

const modeOf = (root: string, step: number): string => readFileSync(join(root, `.cf/work/${String(MINE)}/step-${String(step)}.mode`), 'utf8')

/** An internal plan whose review passed on FOUR in src/hello.ts and whose senior gave `senior`, sent back to build. */
async function passedOn(senior: string): Promise<World> {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, FOUR)
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  await tick(w.db, w.root, stub(CARRIED, 0, senior))
  rewind(w.db, MINE, 2)
  return w
}

async function reworked(w: World, handback: string, ticks: number): Promise<string> {
  const seen: Packet[] = []
  for (let step = 0; step < ticks; step += 1) await tick(w.db, w.root, stub(handback, 0, PASS, (p) => seen.push(p)))
  return reviewer(seen)
}

const seniorRuns = (w: World): unknown => ({ n: runRows(w.db).filter((r) => r.plan === MINE && r.step === 5).length })

test('D1 D2 a stray or over-half rework delta is reviewed in full', async () => {
  const unseen = await passedOn(REFUSE)
  writeFileSync(join(srcDir(unseen.root, MINE), 'src/parse.ts'), 'export const parse = (): number => 1\n')
  const full = await reworked(unseen, OWNS, 3)
  expect(full).toContain('# Your last verdict')
  expect(full).not.toContain('# Changed since your last verdict')
  expect(full).not.toContain('# Paths since your last verdict')
  expect(modeOf(unseen.root, 4)).toBe('full: src/parse.ts is not in the passed diff\n')

  const big = await passedOn(REFUSE)
  built(big.root, MINE, 'export const five = 5\nexport const six = 6\nexport const seven = 7')
  expect(await reworked(big, CARRIED, 3)).not.toContain('# Changed since your last verdict')
  expect(modeOf(big.root, 4)).toBe('full: 3 delta lines is over half of 4 passed\n')
})

test('D3 a comment-only delta is a delta; senior keeps its pass', async () => {
  const w = await passedOn(PASS)
  built(w.root, MINE, '// one to four')
  expect(await reworked(w, CARRIED, 4)).toContain('# Changed since your last verdict')
  expect(modeOf(w.root, 4)).toMatch(/^comment: /)
  expect(seniorRuns(w)).toEqual({ n: 1 })
  expect(verdictRows(w.db, MINE).filter((v) => v.gate === 'senior_review').at(-1))
    .toMatchObject({ outcome: 'pass', tokens: 0, kept_by: null })
  expect(modeOf(w.root, 5)).toBe('skipped: 1 delta lines, comments and docs only\n')
  expect(plan(w.db, MINE).step).toBe(6)
})

test('D4 a code line in the delta still fires senior review', async () => {
  const w = await passedOn(PASS)
  built(w.root, MINE, '// one to four\nexport const five = 5')
  await reworked(w, CARRIED, 4)
  expect(seniorRuns(w)).toEqual({ n: 2 })
  expect(modeOf(w.root, 5)).toMatch(/^delta: /)
})

/** Review's and senior's packets on an internal plan built on FOUR, with Greptile's `OLD` on another head and, if `current`, `NEW` on this one. */
async function greptiled(current: boolean): Promise<Packet[]> {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, FOUR)
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  const bot = (body: string, sha: string): void => {
    signal(w.db, { repo: 'caliperforge/cf', pr: 1, kind: 'bot_review', author: 'greptile', at: '2026-09-26T00:00:00Z',
      external_id: body, score: 5, plan: MINE, body, head: sha })
  }
  bot('OLD', 'f'.repeat(40))
  if (current) bot('NEW', head(srcDir(w.root, MINE), ['rev-parse', 'HEAD']))
  const seen: Packet[] = []
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p)))
  return seen
}

const senior = (packets: Packet[]): string => packets.find((p) => p.prompt.includes('# First verdict'))?.prompt ?? ''

test('D1 D2 D3 only senior gets Greptile, and only at the head', async () => {
  const both = await greptiled(true)
  expect(section(senior(both), 'Greptile on this head')).toBe('NEW')
  expect(senior(both)).not.toContain('OLD')
  expect(reviewer(both)).not.toContain('# Greptile on this head')

  const stale = await greptiled(false)
  expect(senior(stale)).toContain('# First verdict')
  expect(senior(stale)).not.toContain('# Greptile on this head')
  expect(senior(stale)).not.toContain('OLD')
})

test('narrowing gives an untouched moved path to main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-narrow-'))
  const run = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  const commit = (message: string, ...paths: string[]): string =>
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message, ...paths)
  const write = (name: string, body: string): void => { writeFileSync(join(dir, name), body) }
  run('init', '-q', '-b', 'main')
  write('kept.ts', 'export const kept = 1\n')
  run('add', '-A')
  commit('base')
  write('kept.ts', 'export const kept = 2\n')
  write('built.ts', 'export const built = 1\n')
  const tree = snapshot(dir)

  write('main.ts', 'export const main = 1\n')
  run('add', 'main.ts')
  commit('main moves on main.ts', '--', 'main.ts')
  write('built.ts', 'export const built = 2\n')

  expect(narrowing(dir, tree, run('rev-parse', 'HEAD').trim())).toEqual({
    changed: ['built.ts'],
    merged: ['main.ts'],
    unchanged: [['kept.ts', run('rev-parse', `${tree}:kept.ts`).trim()]],
  })
})

test('a senior refusal rebuilds, then walks rails, review, senior', async () => {
  const w = world()
  approve(w.db, w.target)
  const wire = watched([], w.root, 1)
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired).toMatchObject({ step: 5, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md')).toContain(WORDS)

  const walked: string[] = []
  for (let at = 0; at < 4; at += 1) walked.push((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.name ?? '')
  expect(walked).toEqual(['build', 'rails', 'review', 'senior'])
})

test('step 6 sends to our fork, waits the run, records ci-green', async () => {
  const w = world()
  approve(w.db, w.target)
  const sent: string[] = []
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent, w.root, 1))

  const held = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched(sent, w.root, 1, runsOn(w.root, 1, 'in_progress'))))[0]
  expect(held).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(held?.spans).toEqual([`${RUN} ci.pending`])
  expect(sent.slice(2)).toEqual([`send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`])
  expect(plan(w.db, 1).step).toBe(6)
  expect(ciGreen(w)).toEqual([])

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent, w.root, 1)))[0]
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(sent).toHaveLength(4)
  expect(verdictRows(w.db, 1).filter((v) => v.step === 6))
    .toMatchObject([{ rail_id: 'ci-green', gate: 'ready', outcome: 'pass' }, { rail_id: 'ready', gate: 'ready', outcome: 'pass' }])
})

test('step 3 rehearses before review; step 6 opens no second', async () => {
  const w = world()
  approve(w.db, w.target)
  const sent: string[] = []
  const branches: string[] = []
  const runs = runsOn(w.root, 1)
  const wire = watched(sent, w.root, 1, (args) => { branches.push(String(args[args.indexOf('--branch') + 1])); return runs(args) })
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(4)
  const next = `send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`
  expect(sent).toEqual([next, 'rehearse caliperforge/widget widget-12-a1-next'])

  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(7)
  expect(sent.slice(2)).toEqual([next])
  expect(branches).toEqual(['main', 'main', 'widget-12-a1-next'])
})

test('a red fork run sends the plan to the builder with its log', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const red = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))))[0]
  expect(red).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(red?.spans[0]).toMatch(/^ci\.red /)
  expect(planFile(w.root, 'refusal.md')).toContain('their CI is red')
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }])
})

test('a fork red after a no-op rebuild stops instead of cycling', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))
  const lap = async (): Promise<string | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.state

  expect(await lap()).toBe('retried')
  expect(plan(w.db, 1).step).toBe(2)
  for (let at = 0; at < 4; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  expect(await lap()).toBe('blocked_on_ceo')
})

/** Green at a head G on its own branch, then rebuilt to a head H at step 6 that the fork lists red on Validate, with G's run as `g` says. */
const redOnBase = async (g: { status: string; conclusion: string }, log: string[]): Promise<[World, Wire]> => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 7; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  put(w.root, 1, GREEN, get(w.root, 1, GREEN).replace(/^\S+/, 'rehearsal'))
  const base = { branch: 'rehearsal', sha: tip(w.root, 1) }
  const wire = watched([], w.root, 1, rerunning(log, w.root, 1, base, g))
  rewind(w.db, 1, 2)
  await tick(w.db, w.root, builds(() => { built(w.root, 1, 'export const again = 1') }), undefined, undefined, wire)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(6)
  return [w, wire]
}

const ciGreen = (w: World): unknown =>
  verdictRows(w.db, 1).filter((v) => v.rail_id === 'ci-green').map(({ outcome }) => ({ outcome })).reverse()

test('a job red at head and re-run last green is the base\'s', async () => {
  const g = { status: 'completed', conclusion: 'success' }
  const log: string[] = []
  const [w, wire] = await redOnBase(g, log)
  const lap = async (): Promise<unknown> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]

  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', state: 'running' })
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', state: 'running' })
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])

  Object.assign(g, { status: 'completed', conclusion: 'failure' })
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(plan(w.db, 1)).toMatchObject({ step: 7, retries: 0 })
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }, { outcome: 'pass' }])
  expect(log).toHaveLength(1)
})

test('a red job whose last green re-runs green is the builder\'s', async () => {
  const g = { status: 'completed', conclusion: 'success' }
  const [w, wire] = await redOnBase(g, [])
  const lap = async (): Promise<unknown> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]

  await lap()
  await lap()
  g.status = 'completed'
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }, { outcome: 'pass' }])
})

test('a last green head already red is read as is, no re-run', async () => {
  const log: string[] = []
  const [w, wire] = await redOnBase({ status: 'completed', conclusion: 'failure' }, log)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]).toMatchObject({ step: 6, outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
  expect(log).toEqual([])
})

test('a run still going is waited on past the first-run window', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))
  let last
  for (let at = 0; at < 11; at += 1) last = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(last).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(last?.note).toMatch(/is still running CI, tick 11 of 45/)
  expect(ciGreen(w)).toEqual([])
})

test('a gating run still going past 45 ticks goes to the COO', async () => {
  const w = await atCi()
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  await lap()
  put(w.root, 1, 'ci.waits', `${head(srcDir(w.root, 1), ['rev-parse', 'HEAD'])} 45`)
  const out = await lap()
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'needs_ceo', state: 'blocked_on_ceo', spans: ['ci.pending'] })
  expect(out?.note).toMatch(/CI/)
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
})

const atCi = async (): Promise<World> => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  return w
}

const now = (w: World): unknown[] => current(w.db).filter((r) => r.plan === 1).map(({ doing, detail }) => ({ doing, detail }))

test('a CI hold leaves a waiting on CI row in now', async () => {
  const w = await atCi()
  forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', '')))
  expect(now(w)).toEqual([{ doing: 'waiting on CI', detail: expect.stringMatching(/is still running CI, tick 1 of 45$/) as unknown }])
})

test('a CI run judged without a hold leaves no now row', async () => {
  const w = await atCi()
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1))).toBeNull()
  expect(now(w)).toEqual([])
})

interface Listed { status: string; conclusion: string }

/** One run per workflow `runs` names at the head, run ids counting from 1; a `run rerun` goes in `log`. */
const forkRuns = (log: string[], w: World, runs: Record<string, Listed>): Gh => (args) => {
  if (args[1] === 'rerun') {
    log.push(args.join(' '))
    return ''
  }
  const names = Object.keys(runs)
  if (args.includes('--log-failed')) return 'test\tRun\tboom\n'
  if (args[1] === 'view') return JSON.stringify({ workflowName: names[Number(args[2]) - 1] })
  return JSON.stringify(names.map((name, i) => ({ headSha: tip(w.root, 1), ...runs[name], url: RUN.replace(/1$/, String(i + 1)), workflowName: name })))
}

const GREEN_RUN = { status: 'completed', conclusion: 'success' }

test('a head red only through a cancelled run re-runs it and holds', async () => {
  const w = await atCi()
  const log: string[] = []
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: { status: 'completed', conclusion: 'cancelled' }, CI: GREEN_RUN }))
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire))
    .toMatchObject({ outcome: 'pass', held: true, note: expect.stringMatching(/re-running cancelled Harness, tick 1 of 10$/) as unknown })
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
})

test('a cancelled run re-run green passes ci-green', async () => {
  const w = await atCi()
  const log: string[] = []
  const harness = { status: 'completed', conclusion: 'cancelled' }
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: harness, CI: GREEN_RUN }))
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]

  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', state: 'running' })
  Object.assign(harness, { status: 'in_progress', conclusion: '' })
  expect((await lap())?.note).toMatch(/is still running CI, tick 1 of 45$/)
  Object.assign(harness, GREEN_RUN)
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(plan(w.db, 1)).toMatchObject({ step: 7, retries: 0 })
  expect(log).toHaveLength(1)
})

test('a failed run beside a cancelled one goes to the builder', async () => {
  const w = await atCi()
  const log: string[] = []
  const wire = watched([], w.root, 1, forkRuns(log, w, {
    Harness: { status: 'completed', conclusion: 'failure' }, CI: { status: 'completed', conclusion: 'cancelled' } }))
  const red = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(red).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried', spans: ['ci.red Harness', 'ci.red CI'] })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md')).toContain('their CI is red')
  expect(log).toEqual([])
})

test('a run that stays cancelled is re-run once, then to the ceo', async () => {
  const w = await atCi()
  const log: string[] = []
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: { status: 'completed', conclusion: 'cancelled' }, CI: GREEN_RUN }))
  const states: (string | undefined)[] = []
  for (let at = 0; at < 11; at += 1) states.push((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.state)
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(states.at(-1)).toBe('blocked_on_ceo')
  expect(states).not.toContain('retried')
  expect(plan(w.db, 1).step).toBe(6)
})

test('step 6 waits out the push window, then judges the new run', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const sent: string[] = []
  const wire = watched(sent, w.root, 1, runsAfter(w.root, 1, 2))

  const first = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(first).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(first?.spans[0]).toMatch(/ ci\.missing$/)
  expect(first?.note).toMatch(/no run yet, tick 1 of 10/)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.note).toMatch(/tick 2 of 10/)
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1).step).toBe(6)

  const judged = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(judged).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(plan(w.db, 1).step).toBe(7)
  expect(sent).toHaveLength(4)
})

test('a head runless after the window is refused on ci-green', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const wire = watched([], w.root, 1, () => '[]')
  for (let at = 0; at < 10; at += 1) {
    expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
      .toMatchObject({ step: 6, outcome: 'pass', state: 'running' })
  }

  const out = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }])
  expect(plan(w.db, 1).step).toBe(5)
})

/** An outside plan at ready, green on the fork, whose every rehearsal `grade` scores for Greptile or leaves unscored. */
const atReady = async (grade: (w: World) => void, log: string[] = []): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = world()
  approve(w.db, w.target)
  const wire = { ...watched(log, w.root, 1), rehearse: () => { grade(w) } }
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  for (let at = 0; at < 6; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  return [w, lap]
}

const FINDINGS = 'Confidence Score: 3/5\n\nThe empty name is never refused.'

const readyVerdicts = (w: World): unknown => ({ n: verdictRows(w.db, 1).filter((v) => v.rail_id === 'ready').length })

test('D1 no Greptile score holds ready to tick 45; 46 goes on', async () => {
  const [w, lap] = await atReady(() => undefined)
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running', spans: ['greptile.missing'],
    note: expect.stringMatching(/has no Greptile score yet, tick 1 of 45$/) as unknown })
  put(w.root, 1, 'greptile.waits', `${head(srcDir(w.root, 1), ['rev-parse', 'HEAD'])} 44`)
  expect((await lap())?.note).toMatch(/tick 45 of 45$/)
  expect(readyVerdicts(w)).toEqual({ n: 0 })
  expect(plan(w.db, 1).step).toBe(6)
  expect((await lap())?.note).toMatch(/Greptile gave no score in 45 ticks$/)
  expect(plan(w.db, 1).step).toBe(7)
})

test('D2 a 3/5 at the head goes to the builder; at another, none', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 3, FINDINGS) })
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:3/5'] })
  expect(plan(w.db, 1).step).toBe(2)
  expect(get(w.root, 1, 'refusal.md')).toContain(FINDINGS)

  const [old, again] = await atReady((at) => {
    signal(at.db, { repo: 'caliperforge/widget', pr: 1, kind: 'bot_review', author: 'greptile', at: new Date().toISOString(),
      external_id: 'old', score: 3, plan: 1, body: FINDINGS, head: 'f'.repeat(40) })
  })
  expect(await again()).toMatchObject({ step: 6, outcome: 'pass', state: 'running', spans: ['greptile.missing'] })
  expect(plan(old.db, 1).step).toBe(6)
})

const ruling = (sha: string, ids: string): string =>
  `# Rulings\n\naccepted:\n  head: ${sha.slice(0, 12)}\n  ids: ${ids}\n  reason: the SDK divergence is recorded, not patched\n`

/** A 3/5 at the head with `findings` listed for it (`null`: no file), `rulings` and, when given, a hand-back. */
const accepting = (findings: string[] | null, rulings: (sha: string) => string, handback?: string) => (at: World): void => {
  scored(at.root, 1, 3, FINDINGS)
  const sha = head(srcDir(at.root, 1), ['rev-parse', 'HEAD'])
  if (findings !== null) put(at.root, 1, `findings-${sha}.md`, findings.map((id) => `- ${id} ${P2} the empty name is never refused\n`).join(''))
  put(at.root, 1, 'rulings.md', rulings(sha))
  if (handback !== undefined) put(at.root, 1, 'step-2.handback.md', handback)
}

const P2 = '<img alt="P2" src="https://greptile.com/p2.svg">'

test('D2 D7 a 3/5 head with findings accepted or overruled passes', async () => {
  const [w, lap] = await atReady(accepting(['G11', 'G12'], (sha) => ruling(sha, 'G11, G12')))
  expect((await lap())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(w.db, 1).step).toBe(7)
  expect(eventsOf(w.db, 1, 'greptile.accepted')).toEqual([{ actor: 'ready', outcome: 'pass', message: 'G11, G12' }])

  const [d2, again] = await atReady(accepting(['G11', 'G12'], (sha) => `${ruling(sha, 'G11')}G12 overruled: src/hello.ts:1 refuses it\n`))
  expect((await again())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(d2.db, 1).step).toBe(7)
})

test('D3 a 5/5 head with no findings passes', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 5, 'Confidence Score: 5/5') })
  await lap()
  expect(plan(w.db, 1).step).toBe(7)
})

test('D1 D5 D7 an open P2 at senior holds ready on ready_proof', async () => {
  const answered = CARRIED.replace(/---\n$/, '  - id: G12\n    status: done\n    pointer: src/hello.ts:1\n---\n')
  for (const grade of [
    accepting(['G11', 'G12', 'G13'], (sha) => ruling(sha, 'G11, G12')),
    accepting(['G11', 'G12'], () => ruling('f'.repeat(40), 'G11, G12')),
    accepting(['G11', 'G12'], (sha) => ruling(sha, 'G11'), answered),
    accepting(['G11'], () => 'G11 overruled:\n'),
  ]) {
    const [w, lap] = await atReady(grade)
    await lap()
    expect(plan(w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  }
})

test('D4 a 4/5 with a P2 opened after senior goes to the builder', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 4, FINDINGS) })
  put(w.root, 1, `findings-${head(srcDir(w.root, 1), ['rev-parse', 'HEAD'])}.md`, `- G11 ${P2} the empty name is never refused\n`)
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:4/5'] })
  expect(plan(w.db, 1).step).toBe(2)
})

test('D8 a 3/5 head with no findings listed goes to the builder', async () => {
  for (const grade of [accepting(null, (sha) => ruling(sha, 'G11, G12')), accepting([], (sha) => ruling(sha, 'G11, G12'))]) {
    const [w, lap] = await atReady(grade)
    expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:3/5'] })
    expect(plan(w.db, 1).step).toBe(2)
  }
})

test('D4 a 3/5 on an unchanged diff stays at ready', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 3, FINDINGS) })
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', state: 'retried' })
  for (let at = 0; plan(w.db, 1).step !== 6 && at < 8; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  put(w.root, 1, 'issue.md', `${get(w.root, 1, 'issue.md')}\n## Answer from the director\n\nthe SDK refuses it\n`)
  clear(w.db, 1)
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['greptile:3/5'], state: 'retried' })
  expect(plan(w.db, 1).step).toBe(6)
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['greptile:3/5'], state: 'blocked_on_ceo' })
  expect(plan(w.db, 1)).toMatchObject({ step: 6, state: 'blocked_on_ceo' })
})

/** A new head at ready goes back through rails, review and senior before ready judges it. */
const reproved = async (w: World, lap: () => Promise<Fired | undefined>, line: string): Promise<Fired | undefined> => {
  built(w.root, 1, line)
  for (let at = 0; at < 4; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  return lap()
}

test('D6 D7 a new head asks Greptile once; a fourth goes to COO', { timeout: 90_000 }, async () => {
  const log: string[] = []
  const [w, lap] = await atReady(() => undefined, log)
  const asked = (): string[] => log.filter((l) => l.startsWith('review '))
  const round = (line: string): Promise<Fired | undefined> => reproved(w, lap, line)
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', spans: ['greptile.missing'] })
  await lap()
  expect(asked()).toEqual(['review caliperforge/widget widget-12-a1-next'])
  await round('export const two = 2')
  await round('export const three = 3')
  expect(asked()).toHaveLength(3)
  expect(get(w.root, 1, 'greptile.asked').trim().split('\n')).toHaveLength(3)
  expect(await round('export const four = 4')).toMatchObject({ step: 6, outcome: 'needs_ceo', state: 'blocked_on_ceo', spans: ['greptile.requests'] })
  expect(asked()).toHaveLength(3)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
})

/** An outside job at ready with its first head asked, while another job holds `others` of this month's requests. */
const month = async (others: number): Promise<[World, () => string[], (line: string) => Promise<Fired | undefined>]> => {
  const log: string[] = []
  const [w, lap] = await atReady(() => undefined, log)
  put(w.root, 2, 'greptile.asked', `${'f'.repeat(40)} ${new Date().toISOString()}\n`.repeat(others))
  await lap()
  await lap()
  const asked = (): string[] => log.filter((l) => l.startsWith('review '))
  expect(asked()).toHaveLength(1)
  return [w, asked, (line) => reproved(w, lap, line)]
}

test('D2 at 40 this month only the first head is asked', async () => {
  const [w, asked, round] = await month(40)
  expect(await round('export const two = 2')).toMatchObject({ step: 6, outcome: 'needs_ceo', state: 'blocked_on_ceo', spans: ['greptile.month'] })
  expect(asked()).toHaveLength(1)
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
})

test('D3 at 39 this month the second head is asked', async () => {
  const [, asked, round] = await month(38)
  await round('export const two = 2')
  expect(asked()).toHaveLength(2)
})

test('D3 a 4/5 at the current head passes ready to sign-off', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 4, 'Confidence Score: 4/5') })
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
})

test('step 6 refuses a plan with no deliverable row', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  dropDeliverables(w.db, 1)
  const sent: string[] = []

  expect(kernel(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1)))
    .toMatchObject({ outcome: 'refuse', spans: ['deliverables'] })
  expect(sent).toEqual([])
})

test('step 6 refuses a plan with no checkout', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  rmSync(join(srcDir(w.root, 1), '.git'), { recursive: true, force: true })
  const sent: string[] = []

  expect(kernel(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1)))
    .toMatchObject({ outcome: 'refuse', spans: ['checkout'] })
  expect(sent).toEqual([])
})

test('every run row points at a transcript the provider wrote', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  const rows = runRows(w.db)
  expect(rows.map((r) => r.step)).toEqual([1, 2, 4, 5])
  for (const r of rows) {
    expect(r.transcript_path).toMatch(/\.transcript\.jsonl$/)
    expect(existsSync(r.transcript_path)).toBe(true)
  }
})

test('pr-path is measure to push, and each gate writes a verdict', () => {
  expect(steps.map((s) => s.name)).toEqual(['measure', 'ruling', 'build', 'rails', 'review', 'senior', 'ready', 'batch', 'push'])
  expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(steps.filter((s) => s.gate && !s.writes_verdict)).toEqual([])
  expect(steps.filter((s) => s.writes_verdict).map((s) => s.verdict_gate))
    .toEqual(['pre_review', 'review', 'senior_review', 'ready'])
  expect(at(1, 'kotlin')).toMatchObject({ seat: 'brief_writer', runs: 'brief_writer' })
  expect(at(2, 'kotlin')).toMatchObject({ seat: 'kotlin_specialist', runs: 'kotlin_specialist' })
})

test('a rail\'s ticket ids come off the issue, falling back to D1', () => {
  expect(doneIds('- **D1** one\n- **D2** two\n')).toEqual(['D1', 'D2'])
  expect(doneIds('no conditions here')).toEqual(['D1'])
  expect(parse('acme/widget', 'https://github.com/acme/widget/issues/12')).toBe(12)
  expect(() => parse('acme/widget', 'https://example.com/12')).toThrow(/not a github issue url/)
  expect(() => parse('acme/widget', 'https://github.com/other/repo/issues/12')).toThrow(/not acme\/widget/)
})

test('cf brief and cf plan bind the plan they are asked for', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2, 3]) {
    expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1)))[0]?.step).toBe(step)
  }
  expect(runsOf(w.db, 1).map((r) => r.step)).toEqual([1, 2])
  expect(runsOf(w.db, 99)).toEqual([])
  expect(verdictsOf(w.db, 1).map((v) => v.gate)).toEqual(Array<string>(6).fill('pre_review'))
  expect(verdictRows(w.db, 1).map((v) => v.rail_id))
    .toEqual(['completion-audit', 'secret-scan', 'authority', 'tight', 'test-weakened', 'identifiers'])
  expect(verdictsOf(w.db, 99)).toEqual([])
  expect(openPlans(w.db).map((p) => p.id)).toEqual([1])
  expect(halted(w.db)).toEqual([])
  expect(day(w.db)).toMatchObject({ runs: 2, tokens: 120 })
})

test('the kernel deletes a named file before the rails read', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const src = srcDir(w.root, MINE)
  writeFileSync(join(src, 'src/gone.ts'), 'export const gone = 1\n')

  const fired = (await tick(w.db, w.root, stub(dropping(['src/gone.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
  expect(existsSync(join(src, 'src/gone.ts'))).toBe(false)
  expect(diffOf(w.root, MINE)).not.toContain('export const gone = 1')
})

test('a deletion outside the fence refuses the build, naming it', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(dropping(['src/elsewhere.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['src/elsewhere.ts'] })
  expect(fired?.note).toContain('outside the fence')
  expect(existsSync(join(srcDir(w.root, 1), 'src/hello.ts'))).toBe(true)
})

test('deleting a path not in the tree refuses, not a no-op', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(dropping(['src/never-was.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['src/never-was.ts'] })
  expect(fired?.note).toContain('is not in the tree')
})

test('a path named twice is deleted once, not refused as absent', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const src = srcDir(w.root, MINE)
  writeFileSync(join(src, 'src/twice.ts'), 'export const twice = 1\n')

  const fired = (await tick(w.db, w.root, stub(dropping(['src/twice.ts', 'src/twice.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
  expect(existsSync(join(src, 'src/twice.ts'))).toBe(false)
})

test('#374 a path with a `+` in it is deleted', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const src = srcDir(w.root, MINE)
  writeFileSync(join(src, 'src/a+b.ts'), 'export const ab = 1\n')

  const fired = (await tick(w.db, w.root, stub(dropping(['src/a+b.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
  expect(existsSync(join(src, 'src/a+b.ts'))).toBe(false)
  expect(diffOf(w.root, MINE)).not.toContain('export const ab = 1')
})

test('#374 a row naming no path refuses and removes nothing', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(dropping(['src/hello.ts', 'the old spend file']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['- the old spend file'] })
  expect(fired?.note).toContain('names no path')
  expect(existsSync(join(srcDir(w.root, 1), 'src/hello.ts'))).toBe(true)
})

const HELD = 3

/** `HELD` held at the rails on src/hello.ts, which `MINE`, queued at its build in a one-wide pipe, is building. */
async function heldOnMine(): Promise<World> {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  internalPlan(w.db, w.root, HELD, 'let a second internal plan run', 35)
  width(w.db, 1, 2)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  record(w.db, HELD, [{ path: 'src/p3.ts', is_new: true }])
  await tick(w.db, w.root, stub(CARRIED))
  built(w.root, MINE, 'export const landed = true')
  writeFileSync(join(srcDir(w.root, HELD), 'src/p3.ts'), 'export const p3 = true\n')
  built(w.root, HELD, 'export const also = true')
  await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, HELD)).toMatchObject({ step: 3, state: 'running' })
  requeue(w.db, MINE, 2)
  width(w.db, 1, 1)
  return w
}

test('D1 D2 a plan held on one in its pipe gives it its slot', async () => {
  const w = await heldOnMine()
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }).map((p) => p.id)).toEqual([MINE])
  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired.find((f) => f.plan === MINE)).toMatchObject({ step: 2, name: 'build' })
  expect(fired.find((f) => f.plan === HELD)).toBeUndefined()
  expect(parked(w.db).map((p) => [p.id, p.state, p.held_why?.startsWith(`until plan ${String(MINE)} lands`)]))
    .toEqual([[HELD, 'blocked_on_ceo', true]])
})

test('D1 D2 D3 the tick parks a file wait for a queued plan', async () => {
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  internalPlan(w.db, w.root, HELD, 'let a second internal plan run', 35)
  width(w.db, 1, 2)
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect(overlapWaits(w.db)).toMatchObject([{ plan: HELD, on: MINE }])
  width(w.db, 1, 5)
  const added = [4, 5, 6, 7, 8, 9]
  added.forEach((id, at) => internalPlan(w.db, w.root, id, `let plan ${String(id)} run`, 36 + at))
  for (const id of added.slice(0, 3)) advance(w.db, plan(w.db, id), 0)
  await tick(w.db, w.root, stub(CARRIED))
  expect(parked(w.db).map((p) => [p.id, p.held_why?.startsWith(`until plan ${String(MINE)} lands`)])).toEqual([[HELD, true]])
  expect(get(w.root, HELD, 'parked.md')).toContain(`waits on plan ${String(MINE)}`)
  expect(eventsOf(w.db, HELD, 'park')).toEqual([{ actor: 'tick', outcome: 'pass', message: `waits on plan ${String(MINE)}'s files` }])
  expect(added.slice(3).map((id) => plan(w.db, id).state)).toContain('running')
  end(w.db, MINE, 'done')
  pushedRow(w.db, { plan: MINE, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, gates(w.db, MINE, 'd'.repeat(64)))
  await tick(w.db, w.root, stub(CARRIED))
  expect(parked(w.db)).toEqual([])
  expect(plan(w.db, HELD).state).not.toBe('blocked_on_ceo')
  expect(existsSync(join(w.root, `.cf/work/${String(HELD)}/parked.md`))).toBe(false)
})

test('D3 a plan held on one in another pipe keeps its slot', async () => {
  const w = await heldOnMine()
  addPipe(w.db, { name: 'research', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  amend(w.db, MINE, { pipe_id: Number(pipeNamed(w.db, 'research')?.id) })
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }).map((p) => p.id)).toEqual([HELD])
})

function pinned(): { origin: string; work: string; fire: (code: number) => string[]; land: (lock: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-deps-'))
  const [origin, work, bin, calls] = ['origin', 'work', 'bin', 'calls'].map((name) => join(dir, name)) as [string, string, string, string]
  for (const sub of ['launchd', 'cli']) mkdirSync(join(origin, sub), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(origin, 'launchd/tick.sh'), readFileSync(join(import.meta.dirname, '../../launchd/tick.sh')))
  writeFileSync(join(origin, 'cli/cf.ts'), '')
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> ${calls}\nexit $NPM_EXIT\n`, { mode: 0o755 })
  const land = (lock: string): void => {
    writeFileSync(join(origin, 'package-lock.json'), lock)
    head(origin, ['add', '-A'])
    head(origin, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', lock])
  }
  head(origin, ['init', '-q', '-b', 'main'])
  land('{}\n')
  head(dir, ['clone', '-q', origin, work])
  const fire = (code: number): string[] => {
    execFileSync('/bin/sh', [join(work, 'launchd/tick.sh')],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, NPM_EXIT: String(code) } })
    return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
  }
  return { origin, work, fire, land }
}

test('D1 D2 a changed lockfile installs once and keeps its hash', () => {
  const { origin, work, fire, land } = pinned()
  const sha = (): string => readFileSync(join(work, '.cf/deps.lock.sha'), 'utf8').trim()
  expect(fire(0)).toEqual(['ci --include=dev'])
  expect(sha()).toBe(head(origin, ['hash-object', 'package-lock.json']))
  expect(fire(0)).toHaveLength(1)
  land('{"v":2}\n')
  expect(fire(0)).toEqual(['ci --include=dev', 'ci --include=dev'])
  expect(head(work, ['rev-parse', 'HEAD'])).toBe(head(origin, ['rev-parse', 'HEAD']))
  expect(sha()).toBe(head(origin, ['hash-object', 'package-lock.json']))
})

test('D3 a failed install steps HEAD back and logs one deps line', () => {
  const { work, fire, land } = pinned()
  fire(0)
  const was = head(work, ['rev-parse', 'HEAD'])
  const sha = readFileSync(join(work, '.cf/deps.lock.sha'), 'utf8')
  land('{"v":2}\n')
  expect(fire(1)).toHaveLength(2)
  expect(head(work, ['rev-parse', 'HEAD'])).toBe(was)
  expect(readFileSync(join(work, '.cf/deps.lock.sha'), 'utf8')).toBe(sha)
  expect(readFileSync(join(work, '.cf/tick.log'), 'utf8').split('\n').filter((l) => l.startsWith('deps '))).toHaveLength(1)
})
