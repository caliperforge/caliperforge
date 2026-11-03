import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { record as railed } from '../../rails/record.ts'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { measure, type Read } from '../../cli/measure.ts'
import { all } from '../../cli/inbox.ts'
import { account, parse, refuseTarget } from '../../cli/queue.ts'
import { addPipe, advance, allPlans, clock, dropPlan, end, inWindow, laneOff, overlapWaits, parked, pipeNamed, planRows, requeue, resume, rewind, underCap, waiting, type PipeRow, type PlanRow, type Wait } from '../../store/plans.ts'
import { amend, width } from '../../store/lanes.ts'
import { holdOf, retried } from '../../store/holds.ts'
import { current } from '../../store/now.ts'
import { clear } from '../../store/refusals.ts'
import { dropDeliverables, gated, newest, pushedRow } from '../../store/deliverables.ts'
import { gates } from '../../store/approvals.ts'
import { addTarget, setEvidence, setTargetState, targetRow } from '../../store/targets.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { picks } from '../next.ts'
import { blocked, kernel } from '../steps.ts'
import { checkout, diffOf, doneIds, get, gitDiff, headSha, maybe, narrowing, put, snapshot, srcDir } from '../workspace.ts'
import { GREEN } from '../base.ts'
import { record, sharing } from '../../store/files.ts'
import { drop, take } from '../../store/leases.ts'
import { allEvents, eventsOf, kindsOf, newestMode, runRows } from '../../store/events.ts'
import { addReview, overrule, verdictRows } from '../../store/verdict.ts'
import { record as signal } from '../../store/signals.ts'
import { benchPacket } from '../../runner/packet.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import type { Gh } from '../../rails/ci-green/index.ts'
import type { Fired, Outcome } from '../kind.ts'
import { dropped } from '../dropped.ts'
import { hold, unhold } from '../hold.ts'
import { forkCi, rehearsalBranch, type Wire } from '../push.ts'
import { UNRUN } from '../triggers.ts'
import { drift } from '../drift.ts'
import { REGISTRY } from './drifting.ts'
import { GREETED, MANUAL, SCHEDULED, TEX } from './bases.ts'
import { started } from '../signals.ts'
import { closed } from '../unpolled.ts'
import { approve, builds, built, CARRIED, copied, dropping, internalPlan, KOTLIN, once, ours, owning, PASS, plan, PR, REFUSE, rerunning, RUN, runsAfter, runsOn, scored, stub, tip, TYPESCRIPT, watched, WORDS, world, type World } from './world.ts'

vi.mock(import('../../rails/record.ts'), async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, record: vi.fn(real.record) }
})

// a live tick's CF_CHECK_SLOTS reaches the suite it runs, and a check here would queue behind that tick's lanes
delete process.env.CF_CHECK_SLOTS

const head = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0,
    head_digest: null, priority: 1, lane: null, seat: null, origin: null, wait_reason: null, ...over })

/** A world as `world()` opens it: warm, cold, or warm on stale account evidence. */
const FRESH = once(() => world())
const COLD = once(() => world('cold'))
const STALE = once(() => world('warm', '2026-01-01'))
/** FRESH after the tick that measures it, at step 1. */
const MEASURED = once(async () => {
  const w = await FRESH()
  await tick(w.db, w.root, stub(CARRIED))
  return w
})

const laps = async (w: World, n: number, provider: Provider = stub(CARRIED), wire?: Wire): Promise<World> => {
  for (let at = 0; at < n; at += 1) await tick(w.db, w.root, provider, undefined, undefined, wire)
  return w
}

/** An approved outside plan on `files`, whose fork runs no workflow on push. */
const outside = (files: Record<string, string>): World => {
  const w = world('warm', undefined, files, false)
  approve(w.db, w.target)
  return w
}

const lapped = (w: World, n: number): Promise<World> => laps(w, n, stub(CARRIED), watched([], w.root, 1))

/** An approved outside plan at its build, its rails, its review, its senior review and its ready. */
const BRIEFED = once(async () => {
  const w = await MEASURED()
  approve(w.db, w.target)
  return lapped(w, 1)
})
const BUILT = once(async () => lapped(await BRIEFED(), 1))
const REVIEWING = once(async () => lapped(await BUILT(), 1))
const SENIOR = once(async () => lapped(await REVIEWING(), 1))
const AT_CI = once(async () => lapped(await SENIOR(), 1))

/** The head's tally under `key` set to `n` ticks waited. */
const waited = (w: World, key: string, n: number): void => { put(w.root, 1, key, `${headSha(srcDir(w.root, 1))} ${String(n)}`) }

test('a copied world ticks apart from the world it copies', async () => {
  const from = await BRIEFED()
  const w = copied(from)
  const src = srcDir(w.root, 1)
  expect(w.root).not.toBe(from.root)
  expect(w.db.name).toBe(join(w.root, 'world.db'))
  expect(get(w.root, 1, '../../git-base')).toBe(join(w.root, 'remotes'))
  for (const url of ['remote.origin.url', 'remote.upstream.url', 'core.hooksPath']) {
    expect(head(src, ['config', url]).startsWith(`${w.root}/`)).toBe(true)
  }
  const was = { head: head(srcDir(from.root, 1), ['rev-parse', 'HEAD']), hello: readFileSync(join(srcDir(from.root, 1), 'src/hello.ts'), 'utf8') }
  built(w.root, 1, 'export const copy = 1')
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1))
  expect([plan(w.db, 1).step, plan(from.db, 1).step]).toEqual([3, 2])
  expect(runRows(from.db).map((r) => r.step)).toEqual([1])
  expect({ head: head(srcDir(from.root, 1), ['rev-parse', 'HEAD']), hello: readFileSync(join(srcDir(from.root, 1), 'src/hello.ts'), 'utf8') }).toEqual(was)
})

test('outside seat on a stranger\'s repo writes only brief files', async () => {
  const w = await BRIEFED()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
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
  const w = await BUILT()
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
const CACHE = 'kotlin/.gradle/9.7.1/gc.properties'
const JAR = 'kotlin/build/libs/a.jar'
const APP = 'rust/target/debug/app'

/** A source beside the build output or lockfile it makes, for pyc, Gradle, cargo, uv and foundry. */
const ECOSYSTEMS: Record<string, string> = {
  'pkg/m.py': 'x = 1\n', [PYC]: 'compiled',
  'kotlin/Main.kt': 'fun main() {}\n', [CACHE]: 'gc', [JAR]: 'jar',
  'rust/src/main.rs': 'fn main() {}\n', [APP]: 'elf',
  'pyproject.toml': '[project]\nname = "widget"\n', 'uv.lock': 'version = 1\n',
  'foundry.toml': '[profile.default]\nsrc = "src"\n', 'foundry.lock': '{}\n',
}
const SOURCES = ['pkg/m.py', 'kotlin/Main.kt', 'rust/src/main.rs', 'pyproject.toml', 'foundry.toml']
const LEFT_OUT = ['.pyc', '.gradle', 'kotlin/build', 'rust/target', 'uv.lock', 'foundry.lock']

const CHECKED = once(async () => {
  const w = await FRESH()
  checkout(w.root, 1, 'acme/widget', 'widget-12-a1')
  return w
})

const ecosystems = async (): Promise<{ dir: string; base: string; root: string }> => {
  const w = await CHECKED()
  const dir = srcDir(w.root, 1)
  for (const [path, body] of Object.entries(ECOSYSTEMS)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return { dir, base: get(w.root, 1, 'base.sha').trim(), root: w.root }
}

test('build output and untracked lockfiles are not in the diff', async () => {
  const { dir, base } = await ecosystems()
  const diff = gitDiff(dir, base)
  for (const path of SOURCES) expect(diff).toContain(path)
  for (const path of LEFT_OUT) expect(diff).not.toContain(path)
})

test('a reused checkout drops intent-to-add build output', async () => {
  const { dir, base, root } = await ecosystems()
  const added = [PYC, CACHE, APP, 'uv.lock', 'foundry.lock']
  head(dir, ['add', '-f', '--intent-to-add', ...added])
  head(dir, ['add', 'pkg/m.py'])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  expect(head(dir, ['ls-files', '--', ...added])).toBe('')
  expect(head(dir, ['diff', '--cached', '--name-only'])).toBe('pkg/m.py')
  for (const path of LEFT_OUT) expect(gitDiff(dir, base)).not.toContain(path)
})

test('build output HEAD tracks stays in the index and the diff', async () => {
  const { dir, root } = await ecosystems()
  const tracked = [PYC, JAR, APP, 'uv.lock', 'foundry.lock']
  head(dir, ['add', '-f', ...tracked])
  head(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked output'])
  checkout(root, 1, 'acme/widget', 'widget-12-a1')
  for (const path of tracked) expect(head(dir, ['ls-files', '--', path])).toBe(path)
  writeFileSync(join(dir, 'uv.lock'), 'version = 2\n')
  writeFileSync(join(dir, 'foundry.lock'), '{"lib/forge-std": {}}\n')
  const diff = gitDiff(dir, head(dir, ['rev-parse', 'HEAD']))
  expect(diff).toContain('+version = 2')
  expect(diff).toContain('+{"lib/forge-std": {}}')
})

test('a submodule is in the diff only when its commit moved', async () => {
  const w = await CHECKED()
  const dir = srcDir(w.root, 1)
  const dep = join(dir, 'lib/dep')
  const commit = (cwd: string, message: string): string =>
    head(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', message])
  head(dir, ['init', '-q', 'lib/dep'])
  writeFileSync(join(dep, 'a.sol'), 'a\n')
  head(dep, ['add', 'a.sol'])
  commit(dep, 'dep')
  head(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', 'lib/dep'])
  commit(dir, 'gitlink')
  const base = head(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dep, 'a.sol'), 'edited\n')
  writeFileSync(join(dep, 'b.sol'), 'untracked\n')
  expect(gitDiff(dir, base)).not.toContain('lib/dep')
  commit(dep, 'moved')
  expect(gitDiff(dir, base)).toContain('Subproject commit')
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

test('a firing seat holds a now row the lap clears', async () => {
  const w = await MEASURED()
  approve(w.db, w.target)
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
  const w = await FRESH()
  laneOff(w.db, w.pipe.id)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
})

test('step 1 waits on cf approve target, and the plan says so', async () => {
  const w = await FRESH()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).step).toBe(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_approval')
  approve(w.db, w.target)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
})

test('a refused target digest still blocks step 1', async () => {
  const w = await MEASURED()
  refuseTarget(w.db, w.target, 'not.ours', 'coo')
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_approval')
})

test('a comment on our open PR fires the brief, no approval', async () => {
  const w = await MEASURED()
  setEvidence(w.db, w.target, PR)
  const said = signal(w.db, { repo: 'acme/widget', pr: 7, kind: 'comment', author: 'maintainer', at: new Date().toISOString(),
    external_id: 'c1', score: null, plan: 1, body: 'one nit here' })
  expect(said === null ? null : started(w.db, said, w.root)).toMatchObject({ plan: 1, step: 1 })
  const seen: Packet[] = []
  const unreached = (): never => { throw new Error("GraphQL: Could not resolve to a Repository with the name 'acme/widget'.") }
  expect(await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p)), undefined, unreached)).toMatchObject([{ step: 1, outcome: 'pass' }])
  expect(seen.map((p) => p.prompt.includes('# brief_writer') && p.prompt.includes('one nit here'))).toEqual([true])
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('our open PR passes step 1 until it is gone', async () => {
  const w = await MEASURED()
  setEvidence(w.db, w.target, PR)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  closed(w.db, 1, PR, 'MERGED')
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_approval')
})

test('a tick files no plan for an unapproved ready target', async () => {
  const w = await FRESH()
  const id = addTarget(w.db, { ...targetRow(w.db, 1), issue_no: 13, state: 'ready', evidence: 'https://github.com/acme/widget/issues/13' })
  await tick(w.db, w.root, stub(CARRIED))
  expect(allPlans(w.db).filter((p) => p.target_id === id)).toEqual([])
})

test('a parked target holds its plan; a cold pulse alone does not', async () => {
  const w = await COLD()
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_parked')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_parked')
  setTargetState(w.db, 1, 'ready')
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('the store takes only the wait reasons it lists', async () => {
  const w = await COLD()
  expect(() => { waiting(w.db, [{ plan: 1, why: 'because i said so' as Wait }]) }).toThrow(/CHECK constraint/)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('stale account evidence holds nothing; cf queue add measures', async () => {
  const w = await STALE()
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
  const w = await STALE()
  approve(w.db, w.target)
  expect(measure(w.db, 'acme/widget', '2026-09-17', measured('2026-09-17'))).toMatchObject({ pulse: 'warm', doors: 1 })
  expect(targetRow(w.db, 1).account_id).toBe(1)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect((await tick(w.db, w.root, stub(CARRIED), new Date('2026-09-17T09:00:00Z')))[0]?.step).toBe(0)
  expect(plan(w.db, 1).step).toBe(1)
})

/** What the wire was sent while the rails refused the unpointed hand-back once. */
const UNPOINTED_SENT: string[] = []
/** An outside plan whose rails refused an unpointed hand-back once, back at its build. */
const REFUSED_ONCE = once(async () => {
  const w = await BRIEFED()
  return laps(w, 2, stub(UNPOINTED), watched(UNPOINTED_SENT, w.root, 1))
})

test('a rail refusal names spans, steps back, then blocks on ceo', async () => {
  const w = await REFUSED_ONCE()
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(verdictRows(w.db, 1).find((v) => v.rail_id === 'completion-audit')).toMatchObject({ step: 3, outcome: 'refuse' })
  await tick(w.db, w.root, stub(UNPOINTED))
  const stopped = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(stopped).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  expect(holdOf(w.db, 1)).toEqual({ held_by: 'coo', held_why: stopped?.note })
  const verdict = verdictRows(w.db, 1).find((v) => v.rail_id === 'completion-audit')
  expect(verdict).toMatchObject({ outcome: 'refuse', origin_ref: 'completion-audit' })
  expect(stopped?.spans).toEqual(['D1', 'D2'])
})

/** An outside plan whose rails refused the same unpointed hand-back twice, held for the ceo. */
const STOPPED = once(async () => laps(await REFUSED_ONCE(), 2, stub(UNPOINTED)))

const retriedOnce = async (rule: (w: World) => void): Promise<[World, Fired | undefined]> => {
  const w = await STOPPED()
  expect(plan(w.db, 1)).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  rule(w)
  retried(w.db, 1, 'ceo')
  await tick(w.db, w.root, stub(UNPOINTED))
  return [w, (await tick(w.db, w.root, stub(UNPOINTED)))[0]]
}

test('the same refusal after a retry stops again', async () => {
  const [w, fired] = await retriedOnce(() => undefined)
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse', state: 'blocked_on_ceo' })
  expect(planFile(w.root, 'refusal.md')).toContain('# Stopped\n\nthe same refusal came back')
})

const capped = (w: World, fired: Fired | undefined): void => {
  expect(fired).toMatchObject({ step: 3, outcome: 'refuse', state: 'blocked_on_ceo' })
  expect(planFile(w.root, 'refusal.md')).not.toContain('# Stopped')
  expect(planFile(w.root, 'director.md')).toContain('\ncompletion-audit refused it 3 times in a row\n')
}

test('a ruling clears the repeat; the streak cap stops it', async () => {
  capped(...await retriedOnce((w) => { put(w.root, 1, 'ask.md', `${get(w.root, 1, 'ask.md')}\n## Ruling\n\nuse bye()\n`) }))
  capped(...await retriedOnce((w) => { put(w.root, 1, 'rulings.md', 'use bye()\n'); built(w.root, 1, 'export const more = 1') }))
})

test('the bench gets a maintainer view; bad shape refuses first', async () => {
  const w = await REVIEWING()
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 4, outcome: 'pass', state: 'running' })
  const row = verdictRows(w.db, 1).find((v) => v.step === 4)
  expect(row).toMatchObject({ gate: 'review', kind: 'review', outcome: 'pass' })
  const bare = benchPacket(w.root, 'code_quality', 'a handback is not a maintainer view', '/tmp/x.transcript.jsonl')
  expect(bare).toHaveProperty('refusal')
})

const planFile = (root: string, name: string): string => readFileSync(join(root, '.cf/work/1', name), 'utf8')

const PAIR = `${WORDS}\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n---\n`

test('a hand-back repair gets the refused hand-back\'s rows', async () => {
  const w = await REFUSED_ONCE()
  expect(UNPOINTED_SENT).toEqual([])
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  expect(planFile(w.root, 'step-2.handback.prev.md')).toBe(UNPOINTED)
  expect(packets.find((p) => p.tools.length === 0 && p.prompt.includes('# Hand-back repair'))?.prompt)
    .toContain('done:\n  - id: D1\n    status: done\n    pointer:')
})

/** An outside plan whose review refused PAIR, back at its build. */
const PAIRED = once(async () => {
  const w = await REVIEWING()
  await tick(w.db, w.root, stub(CARRIED, 0, PAIR))
  return w
})

test('a review refusal rebuilds with every span, then escalates', async () => {
  const w = await PAIRED()
  const wire = watched([], w.root, 1)
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

const BLOCK = `Decide: may the pull request go upstream?
Options: (a) send it: the maintainer sees it; (b) hold it: the plan waits
Recommend: (a), the diff is signed off
If no answer by 2026-09-28 09:00: the plan stays held`

const ASK = `${WORDS}\n\n${BLOCK}\n\n---\noutcome: needs_ceo\n---\n`

/** An outside plan whose review answered ASK, held for the coo. */
const ESCALATED = once(async () => {
  const w = await REVIEWING()
  await tick(w.db, w.root, stub(CARRIED, 0, ASK))
  return w
})

test('a review needs_ceo holds for the coo with its question', async () => {
  const w = await ESCALATED()
  expect(plan(w.db, 1)).toMatchObject({ step: 4, state: 'blocked_on_ceo' })
  expect(holdOf(w.db, 1)).toEqual({ held_by: 'coo', held_why: `code_quality needs_ceo: ${`${WORDS}\n\n${BLOCK}`.replace(/\s+/g, ' ')}` })
  expect(w.db.prepare('SELECT message FROM verdicts WHERE plan = 1 AND step = 4').get()).toEqual({ message: `${WORDS}\n\n${BLOCK}` })
  const plan1 = allEvents(w.db).filter((e) => e.plan === 1)
  expect(plan1.filter((e) => e.actor === 'code_quality').map((e) => e.outcome)).toEqual(['escalate'])
  expect(plan1.filter((e) => e.kind !== 'director' && e.outcome === 'needs_ceo')).toEqual([])
  expect(eventsOf(w.db, 1, 'director')).toHaveLength(1)
})

test('a repeat escalate on an unchanged tree logs nothing', async () => {
  const w = await ESCALATED()
  const escalates = (): string[] => allEvents(w.db).filter((e) => e.plan === 1 && e.actor === 'code_quality').map((e) => e.outcome)
  resume(w.db, 1)
  expect((await tick(w.db, w.root, stub(CARRIED, 0, ASK)))).toMatchObject([{ outcome: 'needs_ceo', state: 'running' }])
  expect(escalates()).toEqual(['escalate'])
  built(w.root, 1, 'export const two = (): number => 2')
  await tick(w.db, w.root, stub(CARRIED, 0, ASK))
  expect(escalates()).toEqual(['escalate', 'escalate'])
  expect(plan(w.db, 1)).toMatchObject({ state: 'blocked_on_ceo' })
})

test('a new refusal after a rebuild goes round; a repeat stops', async () => {
  const w = await PAIRED()
  const wire = watched([], w.root, 1)
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

const mine = async (files = TYPESCRIPT): Promise<World> => {
  const w = await FRESH()
  dropPlan(w.db, 1)
  ours(w.root, files)
  internalPlan(w.db, w.root, MINE)
  return w
}

/** The packets fired on the way to MINE_SENIOR: its build's and its review's. */
const MINE_SEEN: Packet[] = []
/** One of our own plans at its build, and at its review and its senior review once the build wrote FOUR. */
const MINE_BUILDING = once(async () => laps(await mine(), 2))
const MINE_FOUR = once(async () => {
  const w = await MINE_BUILDING()
  built(w.root, MINE, FOUR)
  return laps(w, 2, stub(CARRIED, 0, PASS, (p) => MINE_SEEN.push(p)))
})
const MINE_SENIOR = once(async () => laps(await MINE_FOUR(), 1, stub(CARRIED, 0, PASS, (p) => MINE_SEEN.push(p))))

/** The first reviewer packet of a round: a builder's carries Write, a reviewer's is Read only. */
const reviewer = (packets: Packet[]): string => packets.find((p) => !p.tools.includes('Write'))?.prompt ?? ''

test('an outside review packet has context and map, no hand-back', async () => {
  const w = await BRIEFED()
  const packets: Packet[] = []
  const inner = builds(() => { writeFileSync(join(srcDir(w.root, 1), 'src/hello.ts'), 'export const hello = (): string => "hello"\n') })
  const seen: Provider = { ...inner, fire: (p) => { packets.push(p); return inner.fire(p) } }
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, seen, undefined, undefined, watched([], w.root, 1))
  const prompt = packets.find((p) => p.prompt.includes('\n# Diff\n'))?.prompt ?? ''
  expect(prompt).toBe(reviewer(packets))
  expect(prompt).not.toContain("# The builder's hand-back")
  expect(prompt).toContain('# Changed code in context')
  expect(prompt).toContain('# Files around the change')
  expect(prompt.indexOf('# Changed code in context')).toBeGreaterThan(prompt.indexOf('# Diff'))
  expect(prompt).not.toContain('\n# Checks that ran\n')
  expect(prompt).toContain('# Symbols at the branch base\n\nEach top-level export at the branch base, as path:line name.\n\nsrc/hello.ts:1 hello\n')
  expect(prompt.indexOf('# Symbols at the branch base')).toBeGreaterThan(prompt.indexOf('# Files around the change'))
})

test('our own plan builds and hands no symbol map', async () => {
  const w = await MINE_SENIOR()
  expect(plan(w.db, MINE).step).toBe(5)
  expect(MINE_SEEN.map((p) => p.prompt.includes('# Symbols at the branch base'))).toEqual([false, false])
  expect(existsSync(join(w.root, '.cf/maps'))).toBe(false)
})

test('a reviewer gets its last verdict and diff, not on its first', async () => {
  const w = await MINE_BUILDING()
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
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
  const w = await MINE_BUILDING()
  const hello = join(srcDir(w.root, MINE), 'src/hello.ts')
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

test('our own step 4 runs typescript_specialist in review', async () => {
  const w = await MINE_SENIOR()
  expect(runRows(w.db).filter((r) => r.plan === MINE && r.step === 4).map((r) => r.seat)).toEqual(['typescript_specialist'])
  expect(newestMode(w.db)).toBe('review')
  expect(verdictRows(w.db, MINE).find((v) => v.step === 4)).toMatchObject({ gate: 'review', kind: 'review', outcome: 'pass' })
})

const modeOf = (root: string, step: number): string => readFileSync(join(root, `.cf/work/${String(MINE)}/step-${String(step)}.mode`), 'utf8')

/** An internal plan whose review passed on FOUR in src/hello.ts and whose senior gave `senior`, sent back to build. */
const passedOn = (senior: string): (() => Promise<World>) => once(async () => {
  const w = await MINE_SENIOR()
  await tick(w.db, w.root, stub(CARRIED, 0, senior))
  rewind(w.db, MINE, 2)
  return w
})
const SENIOR_REFUSED = passedOn(REFUSE)
const SENIOR_PASSED = passedOn(PASS)

async function reworked(w: World, handback: string, ticks: number): Promise<string> {
  const seen: Packet[] = []
  for (let step = 0; step < ticks; step += 1) await tick(w.db, w.root, stub(handback, 0, PASS, (p) => seen.push(p)))
  return reviewer(seen)
}

const seniorRuns = (w: World): unknown => ({ n: runRows(w.db).filter((r) => r.plan === MINE && r.step === 5).length })

test('a stray or over-half rework delta is reviewed in full', async () => {
  const unseen = await SENIOR_REFUSED()
  writeFileSync(join(srcDir(unseen.root, MINE), 'src/parse.ts'), 'export const parse = (): number => 1\n')
  const full = await reworked(unseen, OWNS, 3)
  expect(full).toContain('# Your last verdict')
  expect(full).not.toContain('# Changed since your last verdict')
  expect(full).not.toContain('# Paths since your last verdict')
  expect(modeOf(unseen.root, 4)).toBe('full: src/parse.ts is not in the passed diff\n')

  const big = await SENIOR_REFUSED()
  built(big.root, MINE, 'export const five = 5\nexport const six = 6\nexport const seven = 7')
  expect(await reworked(big, CARRIED, 3)).not.toContain('# Changed since your last verdict')
  expect(modeOf(big.root, 4)).toBe('full: 3 delta lines is over half of 4 passed\n')
})

test('a comment-only delta is a delta; senior keeps its pass', async () => {
  const w = await SENIOR_PASSED()
  built(w.root, MINE, '// one to four')
  expect(await reworked(w, CARRIED, 4)).toContain('# Changed since your last verdict')
  expect(modeOf(w.root, 4)).toMatch(/^comment: /)
  expect(seniorRuns(w)).toEqual({ n: 1 })
  expect(verdictRows(w.db, MINE).filter((v) => v.gate === 'senior_review').at(-1))
    .toMatchObject({ outcome: 'pass', tokens: 0, kept_by: null })
  expect(modeOf(w.root, 5)).toBe('skipped: 1 delta lines, comments and docs only\n')
  expect(plan(w.db, MINE).step).toBe(6)
})

test('a code line in the delta still fires senior review', async () => {
  const w = await SENIOR_PASSED()
  built(w.root, MINE, '// one to four\nexport const five = 5')
  await reworked(w, CARRIED, 4)
  expect(seniorRuns(w)).toEqual({ n: 2 })
  expect(modeOf(w.root, 5)).toMatch(/^delta: /)
})

/** Review's and senior's packets on an internal plan built on FOUR, with Greptile's `OLD` on another head and, if `current`, `NEW` on this one. */
async function greptiled(current: boolean): Promise<Packet[]> {
  const w = await MINE_FOUR()
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

test('only senior gets Greptile, and only at the head', async () => {
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
  const w = await SENIOR()
  const wire = watched([], w.root, 1)
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired).toMatchObject({ step: 5, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md')).toContain(WORDS)

  const walked: string[] = []
  for (let at = 0; at < 4; at += 1) walked.push((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.name ?? '')
  expect(walked).toEqual(['build', 'rails', 'review', 'senior'])
})

const sends = (log: string[]): string[] => log.filter((l) => l.startsWith('send '))

test('step 6 sends to our fork, waits the run, records ci-green', async () => {
  const w = await AT_CI()
  const sent: string[] = []

  const held = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched(sent, w.root, 1, runsOn(w.root, 1, 'in_progress'))))[0]
  expect(held).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(held?.spans).toEqual([`${RUN} ci.pending`])
  expect(sends(sent)).toEqual([`send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`])
  expect(plan(w.db, 1).step).toBe(6)
  expect(ciGreen(w)).toEqual([])

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent, w.root, 1)))[0]
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(sends(sent)).toHaveLength(2)
  expect(verdictRows(w.db, 1).filter((v) => v.step === 6))
    .toMatchObject([{ rail_id: 'ci-green', gate: 'ready', outcome: 'pass' }, { rail_id: 'ready', gate: 'ready', outcome: 'pass' }])
})

test('step 3 rehearses before review; step 6 opens no second', async () => {
  const w = await BUILT()
  const sent: string[] = []
  const branches: string[] = []
  const runs = runsOn(w.root, 1)
  const wire = { ...watched(sent, w.root, 1, (args) => { branches.push(String(args[args.indexOf('--branch') + 1])); return runs(args) }),
    merged: (args: string[]) => args[0] === 'api' ? { default_branch: 'main' } : [],
    forward: (fork: string, base: string) => void sent.push(`forward ${fork} ${base}`) }
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(4)
  const moved = `forward caliperforge/widget ${get(w.root, 1, 'base.sha').trim()}`
  const next = `send src ${tip(w.root, 1)}:refs/heads/widget-12-a1-next`
  expect(sent).toEqual([moved, next, 'rehearse caliperforge/widget widget-12-a1-next'])

  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(7)
  expect(sent.slice(3)).toEqual([moved, next])
  expect(branches).toEqual(['main', 'main', 'widget-12-a1-next'])
})

test('a red fork run sends the plan to the builder with its log', async () => {
  const w = await AT_CI()
  const red = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))))[0]
  expect(red).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(red?.spans[0]).toMatch(/^ci\.red /)
  expect(planFile(w.root, 'refusal.md')).toContain('their CI is red')
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }])
})

test('a fork red after a no-op rebuild stops instead of cycling', async () => {
  const w = await AT_CI()
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))
  const lap = async (): Promise<string | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.state

  expect(await lap()).toBe('retried')
  expect(plan(w.db, 1).step).toBe(2)
  for (let at = 0; at < 4; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  expect(await lap()).toBe('blocked_on_ceo')
})

const GREEN_RUN = { status: 'completed', conclusion: 'success' }

/** The `<branch> <sha>` of the plan's last green head. */
const greenOf = (w: World): { branch: string; sha: string } => {
  const [branch = '', sha = ''] = get(w.root, 1, GREEN).trim().split(' ')
  return { branch, sha }
}

/** Green at a head G on a branch `rehearsal`, then rebuilt to a head H at step 6. */
const REBUILT = once(async () => {
  const w = await lapped(await AT_CI(), 1)
  put(w.root, 1, GREEN, get(w.root, 1, GREEN).replace(/^\S+/, 'rehearsal'))
  const wire = watched([], w.root, 1, rerunning([], w.root, 1, greenOf(w), { ...GREEN_RUN }))
  rewind(w.db, 1, 2)
  await tick(w.db, w.root, builds(() => { built(w.root, 1, 'export const again = 1') }), undefined, undefined, wire)
  return laps(w, 3, stub(CARRIED), wire)
})

/** REBUILT, whose fork lists H red on Validate and G's run as `g` says. */
const redOnBase = async (g: { status: string; conclusion: string }, log: string[]): Promise<[World, Wire]> => {
  const w = await REBUILT()
  expect(plan(w.db, 1).step).toBe(6)
  return [w, watched([], w.root, 1, rerunning(log, w.root, 1, greenOf(w), g))]
}

const ciGreen = (w: World): unknown =>
  verdictRows(w.db, 1).filter((v) => v.rail_id === 'ci-green').map(({ outcome }) => ({ outcome })).reverse()

test('a job red at head and re-run last green is the base\'s', async () => {
  const g = { status: 'completed', conclusion: 'success' }
  const log: string[] = []
  const [w, wire] = await redOnBase(g, log)
  const ci = (): unknown => forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)

  expect(ci()).toMatchObject({ outcome: 'pass', held: true })
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(ci()).toMatchObject({ outcome: 'pass', held: true })
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])

  Object.assign(g, { status: 'completed', conclusion: 'failure' })
  expect(ci()).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }, { outcome: 'pass' }])
  expect(log).toHaveLength(1)
})

test('a red job whose last green re-runs green is the builder\'s', async () => {
  const g = { status: 'completed', conclusion: 'success' }
  const [w, wire] = await redOnBase(g, [])
  for (let at = 0; at < 2; at += 1) forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)
  g.status = 'completed'
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }, { outcome: 'pass' }])
})

test('a last green head already red is read as is, no re-run', async () => {
  const log: string[] = []
  const [w, wire] = await redOnBase({ status: 'completed', conclusion: 'failure' }, log)
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }, { outcome: 'pass' }])
  expect(log).toEqual([])
})

test('a run still going is waited on past the first-run window', async () => {
  const w = await AT_CI()
  waited(w, 'ci.waits', 10)
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))))
    .toMatchObject({ outcome: 'pass', held: true, note: expect.stringMatching(/is still running CI, tick 11 of 45/) as unknown })
  expect(ciGreen(w)).toEqual([])
})

test('a gating run still going past 45 ticks goes to the COO', async () => {
  const w = await AT_CI()
  waited(w, 'ci.waits', 45)
  const out = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))))[0]
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'needs_ceo', state: 'blocked_on_ceo', spans: ['ci.pending'] })
  expect(out?.note).toMatch(/CI/)
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
})

test('an unparked plan starts its CI window at tick 1', async () => {
  const w = await AT_CI()
  waited(w, 'ci.waits', 45)
  hold(w.db, w.root, 1, 'x', new Date(), null, new Date('2099-01-01T00:00:00Z'))
  unhold(w.db, w.root, 1, 'coo')
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))))
    .toMatchObject({ outcome: 'pass', note: expect.stringMatching(/tick 1 of 45/) as unknown })
})

/** `outside(files)` past its rails, its branch on the fork: `forkCi` judges it as step 6 does. */
const railedOn = (files: Record<string, string>): Promise<World> => lapped(outside(files), 4)
const TEX_CI = once(() => railedOn(TEX))
const MANUAL_CI = once(() => railedOn(MANUAL))
const SCHEDULED_CI = once(() => railedOn(SCHEDULED))

const dispatching = (sent: string[]): NonNullable<Wire['dispatch']> => (fork, file, branch) => void sent.push(`${fork} ${file} ${branch}`)

const ciVerdict = (): unknown => vi.mocked(railed).mock.calls.findLast(([, dir]) => dir.endsWith('rails/ci-green'))?.[3]

const OFF = 'caliperforge/widget has Actions off for its workflows: enable them at https://github.com/caliperforge/widget/actions, then cf return 1'

test('a fork with Actions off stops on tick 1, asked again', async () => {
  const w = await AT_CI()
  const wire = { ...watched([], w.root, 1, () => '[]'), actions: () => false }
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(await lap()).toMatchObject({ step: 6, outcome: 'needs_ceo', state: 'blocked_on_ceo', spans: ['fork.actions'], note: OFF })
  expect(ciGreen(w)).toEqual([])
  expect(kindsOf(w.db, 1).filter((e) => e.kind.startsWith('fork.')).at(-1)?.kind).toBe('fork.judged')
  unhold(w.db, w.root, 1, 'ceo')
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)).toMatchObject({ outcome: 'needs_ceo', note: OFF })
})

test.each([true, false])('Actions on (asked: %s) holds as today', async (ask) => {
  const w = await AT_CI()
  let asked = 0
  const sent: string[] = []
  const plain = { ...watched([], w.root, 1, () => '[]'), dispatch: dispatching(sent) }
  const wire = ask ? { ...plain, actions: () => { asked += 1; return true } } : plain
  for (const at of [1, 2]) {
    expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire))
      .toMatchObject({ outcome: 'pass', held: true, note: expect.stringMatching(new RegExp(`has no run yet, tick ${String(at)} of 10$`)) as unknown })
  }
  expect(asked).toBe(ask ? 1 : 0)
  expect(sent).toEqual([])
})

test('a push-to-main tree is dispatched once, then judged', async () => {
  const w = await MANUAL_CI()
  const sent: string[] = []
  const wire = { ...watched([], w.root, 1, () => '[]'), dispatch: dispatching(sent) }
  for (const at of [1, 2]) {
    expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire))
      .toMatchObject({ outcome: 'pass', held: true, note: expect.stringMatching(new RegExp(`has no run yet, tick ${String(at)} of 10$`)) as unknown })
  }
  const once = [`caliperforge/widget ci.yml ${rehearsalBranch(w.root, 1)}`]
  expect(sent).toEqual(once)
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', { ...wire, runs: runsOn(w.root, 1) })).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(sent).toEqual(once)
})

test('a tree no fork workflow runs on passes on tick 1', async () => {
  const w = await TEX_CI()
  let asked = 0
  const sent: string[] = []
  const wire = { ...watched([], w.root, 1, () => '[]'), actions: () => { asked += 1; return true }, dispatch: dispatching(sent) }
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)).toBeNull()
  expect([asked, sent]).toEqual([0, []])
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(ciVerdict()).toMatchObject({ message: expect.stringMatching(new RegExp(`^${UNRUN}; step 3's checks at`)) as unknown })
  expect(maybe(w.root, 1, 'ci.json')).toBe('[]\n')
  expect(maybe(w.root, 1, 'ci.unrun')).toBe(head(srcDir(w.root, 1), ['rev-parse', 'HEAD']))
  expect(eventsOf(w.db, 1, 'ci.unrun')).toEqual([{ actor: 'tick', outcome: 'pass', message: UNRUN }])
})

test('ci.unrun is written once per head sha', async () => {
  const w = await TEX_CI()
  const dir = srcDir(w.root, 1)
  const lap = (): unknown => forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, () => '[]'))
  lap()
  lap()
  const first = head(dir, ['rev-parse', 'HEAD'])
  expect(eventsOf(w.db, 1, 'ci.unrun')).toHaveLength(1)
  expect(maybe(w.root, 1, 'ci.unrun')).toBe(first)
  writeFileSync(join(dir, 'next.txt'), 'next\n')
  head(dir, ['add', 'next.txt'])
  head(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'next'])
  lap()
  expect(eventsOf(w.db, 1, 'ci.unrun')).toHaveLength(2)
  expect(maybe(w.root, 1, 'ci.unrun')).not.toBe(first)
  expect(drift(w.db, REGISTRY.filter((e) => e.name === 'fork_unrun'), new Date())).toEqual([])
})

test('a scheduled-only tree runs no workflows, undispatched', async () => {
  const w = await SCHEDULED_CI()
  const sent: string[] = []
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', { ...watched([], w.root, 1, () => '[]'), dispatch: dispatching(sent) })).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(ciVerdict()).toMatchObject({ message: expect.stringMatching(/^acme\/widget runs no workflows; /) as unknown })
  expect(sent).toEqual([])
  expect(maybe(w.root, 1, 'ci.unrun')).toBeNull()
  expect(eventsOf(w.db, 1, 'ci.unrun')).toEqual([])
})

test('an unrun plan short of pre_review is refused', async () => {
  const w = await TEX_CI()
  addReview(w.db, 'pre_review', 3, 1, { outcome: 'refuse', subject_digest: 'a'.repeat(64), spans: [], origin_kind: 'rail',
    origin_ref: 'tight', message: 'red', defect_class: null }, 0, 0, null)
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, () => '[]'))).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'refuse' }])
  expect(ciVerdict()).toMatchObject({ outcome: 'refuse', spans: ['ci.local'] })
})

const now = (w: World): unknown[] => current(w.db).filter((r) => r.plan === 1).map(({ doing, detail }) => ({ doing, detail }))

test('a CI hold leaves a waiting on CI row in now', async () => {
  const w = await AT_CI()
  forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', '')))
  expect(now(w)).toEqual([{ doing: 'waiting on CI', detail: expect.stringMatching(/is still running CI, tick 1 of 45$/) as unknown }])
})

test('a CI run judged without a hold leaves no now row', async () => {
  const w = await AT_CI()
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', watched([], w.root, 1))).toBeNull()
  expect(now(w)).toEqual([])
})

test('a ref the fork rejected refuses step 6 unsent', async () => {
  const w = await AT_CI()
  const pushed = tip(w.root, 1)
  const sends = (): number => kindsOf(w.db, 1).filter((e) => e.kind === 'fork.sent').length
  const before = sends()
  const log: string[] = []
  const out = forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', { ...watched(log, w.root, 1), at: () => 'f'.repeat(40) })
  expect(out).toMatchObject({ outcome: 'refuse', spans: ['fork.sent'], to: 6 })
  expect(out?.note).toContain('rejected refs/heads/')
  expect(out?.note).toContain(pushed.slice(0, 12))
  expect(sends()).toBe(before)
  expect(maybe(w.root, 1, 'ci.waits')).toBeNull()
  expect(log.filter((l) => l.startsWith('rehearse'))).toEqual([])
})

test('a ref the fork holds at the pushed tip is judged', async () => {
  const w = await AT_CI()
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', { ...watched([], w.root, 1), at: () => tip(w.root, 1) })).toBeNull()
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

test('a head red only through a cancelled run re-runs it and holds', async () => {
  const w = await AT_CI()
  const log: string[] = []
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: { status: 'completed', conclusion: 'cancelled' }, CI: GREEN_RUN }))
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire))
    .toMatchObject({ outcome: 'pass', held: true, note: expect.stringMatching(/re-running cancelled Harness, tick 1 of 10$/) as unknown })
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
})

test('a cancelled run re-run green passes ci-green', async () => {
  const w = await AT_CI()
  const log: string[] = []
  const harness = { status: 'completed', conclusion: 'cancelled' }
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: harness, CI: GREEN_RUN }))
  const ci = (): unknown => forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)

  expect(ci()).toMatchObject({ outcome: 'pass', held: true })
  Object.assign(harness, { status: 'in_progress', conclusion: '' })
  expect(ci()).toMatchObject({ note: expect.stringMatching(/is still running CI, tick 1 of 45$/) as unknown })
  Object.assign(harness, GREEN_RUN)
  expect(ci()).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(log).toHaveLength(1)
})

test('a failed run beside a cancelled one goes to the builder', async () => {
  const w = await AT_CI()
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
  const w = await AT_CI()
  const log: string[] = []
  const wire = watched([], w.root, 1, forkRuns(log, w, { Harness: { status: 'completed', conclusion: 'cancelled' }, CI: GREEN_RUN }))
  expect(forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)).toMatchObject({ outcome: 'pass', held: true })
  waited(w, 'ci.waits.rerun', 10)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]).toMatchObject({ step: 6, outcome: 'needs_ceo', state: 'blocked_on_ceo' })
  expect(log).toEqual(['run rerun 1 --repo caliperforge/widget'])
  expect(plan(w.db, 1).step).toBe(6)
})

test('step 6 waits out the push window, then judges the new run', async () => {
  const w = await AT_CI()
  const sent: string[] = []
  const wire = watched(sent, w.root, 1, runsAfter(w.root, 1, 2))

  const ci = (): unknown => forkCi(w.db, w.root, plan(w.db, 1), 'acme/widget', wire)
  expect(ci()).toMatchObject({ outcome: 'pass', held: true, spans: [expect.stringMatching(/ ci\.missing$/) as unknown],
    note: expect.stringMatching(/no run yet, tick 1 of 10/) as unknown })
  expect(ci()).toMatchObject({ note: expect.stringMatching(/tick 2 of 10/) as unknown })
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1).step).toBe(6)

  expect(ci()).toBeNull()
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(sends(sent)).toHaveLength(3)
})

test('a head runless after the window goes to the ceo', async () => {
  const w = await AT_CI()
  waited(w, 'ci.waits', 10)

  const out = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, 1, () => '[]')))[0]
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'needs_ceo', state: 'blocked_on_ceo' })
  expect(out?.note).toMatch(/ran no workflow at [0-9a-f]{12} in 10 ticks$/)
  expect(ciGreen(w)).toEqual([])
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
})

test('an outside repo with no workflows passes on step 3', async () => {
  const w = outside(TYPESCRIPT)
  const sent: string[] = []
  const wire = watched(sent, w.root, 1, (args) => {
    if (args.includes('main')) return '[]'
    throw new Error('no workflows: github is never asked for runs at the head')
  })
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire)
  expect(plan(w.db, 1).step).toBe(6)

  const out = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
  expect(ciGreen(w)).toEqual([{ outcome: 'pass' }])
  expect(get(w.root, 1, 'ci.json')).toBe('[]\n')
  expect(kindsOf(w.db, 1).map((e) => e.kind).filter((k) => k.startsWith('fork.')).slice(-2)).toEqual(['fork.sent', 'fork.judged'])
  expect(sent.filter((l) => l.startsWith('send '))).not.toEqual([])
})

const unrehearsed = (w: World): Wire => ({ ...watched([], w.root, 1), rehearse: () => undefined })

/** An outside plan Greptile never scored, at its senior review and at its ready. */
const UNGRADED = once(async () => {
  const w = await BUILT()
  return laps(w, 2, stub(CARRIED), unrehearsed(w))
})
const UNSCORED = once(async () => {
  const w = await UNGRADED()
  return laps(w, 1, stub(CARRIED), unrehearsed(w))
})

const unscored = async (log: string[] = [], over: Partial<Wire> = {}): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = await UNSCORED()
  const wire = { ...watched(log, w.root, 1), rehearse: () => undefined, ...over }
  return [w, async () => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]]
}

test('a runless head goes to the ceo before Greptile', async () => {
  const log: string[] = []
  const [w, lap] = await unscored(log, { runs: () => '[]' })
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', state: 'running', spans: [expect.stringMatching(/ ci\.missing$/) as unknown] })
  waited(w, 'ci.waits', 10)

  const out = await lap()
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'needs_ceo' })
  expect(out?.spans[0]).toMatch(/ ci\.missing$/)
  expect(out?.spans).not.toEqual(['ci-green'])
  expect(log.filter((l) => l.startsWith('review '))).toEqual([])
  expect(maybe(w.root, 1, 'greptile.asked')).toBeNull()
  expect(ciGreen(w)).toEqual([])
  expect(readyVerdicts(w)).toEqual({ n: 0 })
})

/**
 * An outside plan at ready, green on the fork, graded by `grade` and at every rehearsal after. Ready reads the score at the
 * tick; `senior` grades it before senior review, whose deliverable row then holds it.
 */
const atReady = async (grade: (w: World) => void, senior = false): Promise<[World, () => Promise<Fired | undefined>]> => {
  const w = await (senior ? UNGRADED : UNSCORED)()
  grade(w)
  const wire = { ...watched([], w.root, 1), rehearse: () => { grade(w) } }
  const lap = async (): Promise<Fired | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  if (senior) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  return [w, lap]
}

const FINDINGS = 'Confidence Score: 3/5\n\nThe empty name is never refused.'

const readyVerdicts = (w: World): unknown => ({ n: verdictRows(w.db, 1).filter((v) => v.rail_id === 'ready').length })

test('no Greptile score holds ready to tick 45; 46 goes on', async () => {
  const [w, lap] = await unscored()
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running', spans: ['greptile.missing'],
    note: expect.stringMatching(/has no Greptile score yet, tick 1 of 45$/) as unknown })
  waited(w, 'greptile.waits', 44)
  expect((await lap())?.note).toMatch(/tick 45 of 45$/)
  expect(readyVerdicts(w)).toEqual({ n: 0 })
  expect(plan(w.db, 1).step).toBe(6)
  expect((await lap())?.note).toMatch(/Greptile gave no score in 45 ticks$/)
  expect(plan(w.db, 1).step).toBe(7)
})

test('a fork without Greptile refuses ready and asks nothing', async () => {
  const log: string[] = []
  const [w, lap] = await unscored(log, { greptile: () => false })
  expect(await lap()).toMatchObject({ step: 6, outcome: 'refuse', spans: ['greptile.installed'],
    note: 'Greptile is not installed on caliperforge/widget' })
  expect(log.filter((l) => l.startsWith('review '))).toEqual([])
  expect(maybe(w.root, 1, 'greptile.asked')).toBeNull()
  expect(plan(w.db, 1).step).toBe(6)
})

test('a 3/5 at the head goes to the builder; at another, none', async () => {
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

test('a 3/5 head with findings accepted or overruled passes', async () => {
  const [w, lap] = await atReady(accepting(['G11', 'G12'], (sha) => ruling(sha, 'G11, G12')))
  expect((await lap())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(w.db, 1).step).toBe(7)
  expect(eventsOf(w.db, 1, 'greptile.accepted')).toEqual([{ actor: 'ready', outcome: 'pass', message: 'G11, G12' }])

  const [d2, again] = await atReady(accepting(['G11', 'G12'], (sha) => `${ruling(sha, 'G11')}G12 overruled: src/hello.ts:1 refuses it\n`))
  expect((await again())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(d2.db, 1).step).toBe(7)
})

/** A 0/5 whose summary links `ids` as P1 findings, with G11 and G12 accepted at an earlier head. */
const linking = (ids: number[]) => (at: World): void => {
  scored(at.root, 1, 0, `Confidence Score: 0/5\n\n${ids.map((n) =>
    `1. ${P1}&nbsp;**Bug** <a href="https://github.com/caliperforge/widget/pull/1#discussion_r${String(n)}">▶</a>\n`).join('')}`)
  put(at.root, 1, 'rulings.md', ruling('f'.repeat(40), 'G11, G12'))
}

const P1 = '<img alt="P1" src="https://greptile.com/p1.svg">'

test('a 0/5 linking a P1 no ruling overrules in code refuses', async () => {
  const [w, lap] = await atReady(linking([11, 12]))
  const fired = await lap()
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:0/5'] })
  expect(fired?.note).toContain('the COO accepted G11, G12, but a P1 needs a ruling citing the code')
  expect(plan(w.db, 1).step).toBe(2)

  const [, again] = await atReady(linking([11, 12, 13]))
  expect(await again()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:0/5'] })
})

test('a 0/5 whose P1s are overruled citing the code passes', async () => {
  const [w, lap] = await atReady((at) => {
    linking([11, 12])(at)
    put(at.root, 1, 'rulings.md', 'G11, G12 overruled: src/hello.ts:1 already refuses it\n')
  })
  expect((await lap())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(w.db, 1).step).toBe(7)
  expect(eventsOf(w.db, 1, 'greptile.accepted')).toEqual([{ actor: 'ready', outcome: 'pass', message: 'G11, G12' }])
})

test('a ruling after senior raises bot_clean at the tick', async () => {
  let ids = 'G11'
  const [w, lap] = await atReady(accepting(['G11', 'G12'], (sha) => ruling(sha, ids)), true)
  await lap()
  expect(plan(w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  expect(newest(w.db, 1)?.bot_clean).toBe(0)
  ids = 'G11, G12'
  put(w.root, 1, 'rulings.md', ruling(head(srcDir(w.root, 1), ['rev-parse', 'HEAD']), ids))
  expect((await lap())?.note).toMatch(/the COO accepted G11, G12$/)
  expect(plan(w.db, 1).step).toBe(7)
  expect(newest(w.db, 1)).toMatchObject({ state: 'ready', bot_clean: 1 })
})

test('an outside bot score under 5 at the head still refuses', async () => {
  const [w, lap] = await atReady(accepting(['G11', 'G12'], (sha) => ruling(sha, 'G11, G12')), true)
  const { seat, diff_digest, evidence } = newest(w.db, 1) ?? expect.fail('no deliverable row')
  gated(w.db, { plan: 1, step: 5, seat, diff_digest, evidence },
    { tests_pass: true, byte_identical_elsewhere: true, fork_ci_green: true, bot_clean: false, target_warm: true })
  signal(w.db, { repo: 'acme/widget', pr: 1, kind: 'bot_review', author: 'greptile', at: new Date().toISOString(),
    external_id: 'outside', score: 3, plan: 1, body: FINDINGS, head: head(srcDir(w.root, 1), ['rev-parse', 'HEAD']) })
  expect((await lap())?.spans).toContain('bot:1 ready.bot_clean')
  expect(newest(w.db, 1)?.bot_clean).toBe(0)
})

test('a 4/5 or 5/5 at the head passes ready to sign-off', async () => {
  for (const score of [5, 4]) {
    const [w, lap] = await atReady((at) => { scored(at.root, 1, score, `Confidence Score: ${String(score)}/5`) })
    expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
    expect(plan(w.db, 1).step).toBe(7)
  }
})

test('an open P2 at senior holds ready on ready_proof', async () => {
  const answered = CARRIED.replace(/---\n$/, '  - id: G12\n    status: done\n    pointer: src/hello.ts:1\n---\n')
  for (const grade of [
    accepting(['G11', 'G12', 'G13'], (sha) => ruling(sha, 'G11, G12')),
    accepting(['G11', 'G12'], (sha) => ruling(sha, 'G11'), answered),
    accepting(['G11'], () => 'G11 overruled:\n'),
  ]) {
    const [w, lap] = await atReady(grade, true)
    await lap()
    expect(plan(w.db, 1)).toMatchObject({ step: 6, wait_reason: 'ready_proof' })
  }
})

test('a 4/5 with a P2 opened after senior stays at ready', async () => {
  const [w, lap] = await atReady((at) => { scored(at.root, 1, 4, FINDINGS) }, true)
  put(w.root, 1, `findings-${head(srcDir(w.root, 1), ['rev-parse', 'HEAD'])}.md`, `- G11 ${P2} the empty name is never refused\n`)
  expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:4/5'] })
  expect(plan(w.db, 1).step).toBe(6)
})

test('a 3/5 head with no findings listed goes to the builder', async () => {
  for (const grade of [accepting(null, (sha) => ruling(sha, 'G11, G12')), accepting([], (sha) => ruling(sha, 'G11, G12'))]) {
    const [w, lap] = await atReady(grade)
    expect(await lap()).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', spans: ['greptile:3/5'] })
    expect(plan(w.db, 1).step).toBe(2)
  }
})

test('a 3/5 on an unchanged diff stays at ready', async () => {
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

test('a later head is not asked Greptile again', async () => {
  const log: string[] = []
  const [w, lap] = await unscored(log)
  const asked = (): string[] => log.filter((l) => l.startsWith('review '))
  expect(await lap()).toMatchObject({ step: 6, outcome: 'pass', spans: ['greptile.missing'] })
  await lap()
  expect(asked()).toEqual(['review caliperforge/widget widget-12-a1-next'])
  const fired = await reproved(w, lap, 'export const two = 2')
  expect(fired).toMatchObject({ step: 6, outcome: 'pass' })
  expect(fired?.note).toMatch(/Greptile reviewed [0-9a-f]{12} once; [0-9a-f]{12} is not asked again/)
  expect(asked()).toHaveLength(1)
  expect(get(w.root, 1, 'greptile.asked').trim().split('\n')).toHaveLength(1)
  expect(plan(w.db, 1).step).toBe(7)
})

test('step 6 refuses a plan with no deliverable row', async () => {
  const w = await AT_CI()
  dropDeliverables(w.db, 1)
  const sent: string[] = []

  expect(kernel(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1)))
    .toMatchObject({ outcome: 'refuse', spans: ['deliverables'] })
  expect(sent).toEqual([])
})

test('step 6 refuses a plan with no checkout', async () => {
  const w = await AT_CI()
  rmSync(join(srcDir(w.root, 1), '.git'), { recursive: true, force: true })
  const sent: string[] = []

  expect(kernel(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1)))
    .toMatchObject({ outcome: 'refuse', spans: ['checkout'] })
  expect(sent).toEqual([])
})

test('every run row points at a transcript the provider wrote', async () => {
  const w = await AT_CI()
  const rows = runRows(w.db)
  expect(rows.map((r) => r.step)).toEqual([1, 2, 4, 5, 5])
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

test('a rail takes its case ids off the issue, or one by default', () => {
  expect(doneIds('- **D1** one\n- **D2** two\n')).toEqual(['D1', 'D2'])
  expect(doneIds('no conditions here')).toEqual(['D1'])
  expect(parse('acme/widget', 'https://github.com/acme/widget/issues/12')).toBe(12)
  expect(() => parse('acme/widget', 'https://example.com/12')).toThrow(/not a github issue url/)
  expect(() => parse('acme/widget', 'https://github.com/other/repo/issues/12')).toThrow(/not acme\/widget/)
})

test('cf brief and cf plan bind the plan they are asked for', async () => {
  const w = await REVIEWING()
  expect(runsOf(w.db, 1).map((r) => r.step)).toEqual([1, 2])
  expect(runsOf(w.db, 99)).toEqual([])
  expect(verdictsOf(w.db, 1).map((v) => v.gate)).toEqual(Array<string>(4).fill('pre_review'))
  expect(verdictRows(w.db, 1).map((v) => v.rail_id))
    .toEqual(['completion-audit', 'secret-scan', 'authority', 'test-weakened'])
  expect(verdictsOf(w.db, 99)).toEqual([])
  expect(openPlans(w.db).map((p) => p.id)).toEqual([1])
  expect(halted(w.db)).toEqual([])
  expect(day(w.db)).toMatchObject({ runs: 2, tokens: 120 })
})

const GREETED_BUILDING = once(async () => laps(await mine(GREETED), 2))

const pack = (src: string): void => {
  mkdirSync(join(src, '.git/objects/pack'), { recursive: true })
  writeFileSync(join(src, '.git/objects/pack/x.pack'), 'pack\n')
}

/** A build's `## Deleted` rows on the plan `id` of `from`, after `before` readies its checkout. */
interface Deletion { from: () => Promise<World>; id: number; paths: string[]; before?: (src: string) => void }

/** Through a tick's build step on a copy of its own when `ticked`, else straight to `dropped`, the call that step makes, on the copy of `from` the rows share. */
const deleted = async ({ from, id, paths, before }: Deletion, ticked: boolean, copies: Map<Deletion['from'], World>): Promise<{ w: World; src: string; out: Fired | Outcome | null | undefined }> => {
  const w = ticked ? await from() : copies.get(from) ?? await from()
  if (!ticked) copies.set(from, w)
  const src = srcDir(w.root, id)
  before?.(src)
  const row = plan(w.db, id)
  const out = ticked ? (await tick(w.db, w.root, stub(dropping(paths))))[0]
    : dropped(w.db, w.root, row, at(2, row.target_id === null ? 'typescript' : 'outside'), dropping(paths))
  return { w, src, out }
}

const REFUSED: (Deletion & { span: string; note?: string; stays?: string })[] = [
  { from: BRIEFED, id: 1, paths: ['src/elsewhere.ts'], span: 'src/elsewhere.ts', note: 'outside the fence', stays: 'src/elsewhere.ts',
    before: (src) => { writeFileSync(join(src, 'src/elsewhere.ts'), 'export const elsewhere = 1\n') } },
  { from: BRIEFED, id: 1, paths: ['src/hello.ts', 'the old spend file'], span: '- the old spend file', note: 'names no path', stays: 'src/hello.ts' },
  { from: MINE_BUILDING, id: MINE, paths: ['../issue.md'], span: '../issue.md', stays: '../issue.md' },
  { from: MINE_BUILDING, id: MINE, paths: ['.git/objects/pack/x.pack'], span: '.git/objects/pack/x.pack', note: 'is under .git',
    stays: '.git/objects/pack/x.pack', before: pack },
  { from: MINE_BUILDING, id: MINE, paths: ['.GIT/objects/pack/x.pack'], span: '.GIT/objects/pack/x.pack', stays: '.git/objects/pack/x.pack', before: pack },
  { from: GREETED_BUILDING, id: MINE, paths: ['src/tests/hello.test.ts'], span: 'src/tests/hello.test.ts', note: 'is on base',
    stays: 'src/tests/hello.test.ts' },
  { from: GREETED_BUILDING, id: MINE, paths: ['src/tests/hello.test.ts'], span: 'src/tests/hello.test.ts',
    before: (src) => { rmSync(join(src, 'src/tests/hello.test.ts')) } },
  { from: MINE_BUILDING, id: MINE, paths: ['src/never-was.ts'], span: 'src/never-was.ts', note: 'is not in the tree' },
]

test('a deletion outside the fence or off the tree refuses', async () => {
  const copies = new Map<Deletion['from'], World>()
  for (const [n, row] of REFUSED.entries()) {
    const { src, out } = await deleted(row, n === 0, copies)
    expect(out, row.span).toMatchObject({ ...(n === 0 ? { step: 2, name: 'build' } : {}), outcome: 'refuse', spans: [row.span] })
    if (row.note !== undefined) expect(out?.note, row.span).toContain(row.note)
    if (row.stays !== undefined) expect(existsSync(join(src, row.stays)), row.span).toBe(true)
  }
})

const PASSED: (Deletion & { gone: string; diff?: { has?: string; lacks?: string } })[] = [
  { from: MINE_BUILDING, id: MINE, paths: ['src/a+b.ts'], gone: 'src/a+b.ts', diff: { lacks: 'export const ab = 1' },
    before: (src) => { writeFileSync(join(src, 'src/a+b.ts'), 'export const ab = 1\n') } },
  { from: BRIEFED, id: 1, paths: ['uv.lock'], gone: 'uv.lock', before: (src) => { writeFileSync(join(src, 'uv.lock'), 'version = 1\n') } },
  { from: MINE_BUILDING, id: MINE, paths: ['src/hello.ts'], gone: 'src/hello.ts', diff: { has: 'deleted file' } },
  { from: MINE_BUILDING, id: MINE, paths: ['src/hello.ts'], gone: 'src/hello.ts', diff: { has: 'deleted file' },
    before: (src) => { rmSync(join(src, 'src/hello.ts'), { force: true }) } },
  { from: MINE_BUILDING, id: MINE, paths: ['src/twice.ts', 'src/twice.ts'], gone: 'src/twice.ts',
    before: (src) => { writeFileSync(join(src, 'src/twice.ts'), 'export const twice = 1\n') } },
]

test('a deletion the fence allows goes before the rails read', async () => {
  const copies = new Map<Deletion['from'], World>()
  for (const [n, row] of PASSED.entries()) {
    const { w, src, out } = await deleted(row, n === 0, copies)
    if (n === 0) expect(out).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
    else expect(out, row.gone).toBe(null)
    expect(existsSync(join(src, row.gone)), row.gone).toBe(false)
    if (row.diff?.has !== undefined) expect(diffOf(w.root, row.id), row.gone).toContain(row.diff.has)
    if (row.diff?.lacks !== undefined) expect(diffOf(w.root, row.id), row.gone).not.toContain(row.diff.lacks)
  }
})

const HELD = 3

/** `MINE` and `HELD` in a two-wide pipe, both briefed. */
const TWO = once(async () => {
  const w = await mine()
  internalPlan(w.db, w.root, HELD, 'let a second internal plan run', 35)
  width(w.db, 1, 2)
  return laps(w, 2)
})

/** `HELD` held at the rails on src/hello.ts, which `MINE`, queued at its build in a one-wide pipe, is building. */
const HELD_ON_MINE = once(async () => {
  const w = await TWO()
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
})

test('a plan held on one in its pipe gives it its slot', async () => {
  const w = await HELD_ON_MINE()
  expect(picks(w.db, { ...w.pipe, max_concurrent: 1 }).map((p) => p.id)).toEqual([MINE])
  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired.find((f) => f.plan === MINE)).toMatchObject({ step: 2, name: 'build' })
  expect(fired.find((f) => f.plan === HELD)).toBeUndefined()
  expect(parked(w.db).map((p) => [p.id, p.state, p.held_why?.startsWith(`until plan ${String(MINE)} lands`)]))
    .toEqual([[HELD, 'blocked_on_ceo', true]])
})

test('the tick parks a file wait for a queued plan', async () => {
  const w = await TWO()
  await tick(w.db, w.root, stub(CARRIED))
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
  waiting(w.db, [{ plan: HELD, why: 'leased' }])
  expect(planRows(w.db).find((r) => r.id === HELD)).toMatchObject({ waits_on: MINE })
  end(w.db, MINE, 'done')
  pushedRow(w.db, { plan: MINE, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, gates(w.db, MINE, 'd'.repeat(64)))
  await tick(w.db, w.root, stub(CARRIED))
  expect(parked(w.db)).toEqual([])
  expect(plan(w.db, HELD).state).not.toBe('blocked_on_ceo')
  expect(all(w.root)).toContainEqual(expect.objectContaining({ plan: HELD, name: 'fixer', note: `plan ${String(MINE)} landed, so this job is back in its lane` }))
  expect(existsSync(join(w.root, `.cf/work/${String(HELD)}/parked.md`))).toBe(false)
})

test('a P0 takes a built P1\'s files between its steps', async () => {
  const w = await TWO()
  await tick(w.db, w.root, stub(CARRIED))
  expect(overlapWaits(w.db)).toMatchObject([{ plan: HELD, on: MINE }])
  amend(w.db, HELD, { priority: 0 })
  expect(sharing(w.db, HELD)).toBeNull()
  take(w.db, MINE)
  expect(sharing(w.db, HELD)).toMatchObject({ plan: MINE })
  internalPlan(w.db, w.root, 4, 'let plan 4 run', 36)
  await tick(w.db, w.root, stub(CARRIED))
  expect(parked(w.db)).toEqual([])
  drop(w.db, MINE)
  const fired = await tick(w.db, w.root, stub(CARRIED))
  expect(fired[0]).toMatchObject({ plan: HELD, step: 2, name: 'build' })
  expect(parked(w.db).map((p) => [p.id, p.held_why?.startsWith(`until plan ${String(HELD)} lands`)])).toEqual([[MINE, true]])
  expect(eventsOf(w.db, MINE, 'park')).toEqual([{ actor: 'tick', outcome: 'pass', message: `waits on plan ${String(HELD)}'s files` }])
})

test('a plan held on one in another pipe keeps its slot', async () => {
  const w = await HELD_ON_MINE()
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

test('a changed lockfile installs once and keeps its hash', () => {
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

test('a failed install steps HEAD back and logs one deps line', () => {
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
