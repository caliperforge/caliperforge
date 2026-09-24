import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { measure, type Read } from '../../cli/measure.ts'
import { account, parse } from '../../cli/queue.ts'
import { clock, inWindow, underCap, waiting, type PipeRow, type PlanRow, type Wait } from '../../store/plans.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { blocked, kernel } from '../steps.ts'
import { diffOf, doneIds, narrowing, snapshot, srcDir } from '../workspace.ts'
import { record } from '../../store/files.ts'
import { benchPacket } from '../../runner/packet.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import { approve, builds, built, CARRIED, dropping, internalPlan, KOTLIN, ours, owning, PASS, plan, REFUSE, RUN, runsAfter, runsOn, stub, watched, WORDS, world } from './world.ts'

const head = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0,
    head_digest: null, priority: 1, lane: null, seat: null, origin: null, wait_reason: null, ...over })

test('on a stranger\'s repo the builder is the outside seat and may write only the brief\'s files', async () => {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  const builder = packets.find((p) => p.tools.includes('Write'))
  expect(builder?.prompt).toContain('# outside_specialist')
  const src = realpathSync(srcDir(w.root, 1))
  expect(builder?.cwd).toBe(srcDir(w.root, 1))
  expect(builder?.refuse(join(src, 'src/hello.ts'))).toBeNull()
  expect(builder?.refuse('src/nested/hello.ts')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse(join(src, 'README.md'))).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse(join(src, '../issue.md'))).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(builder?.refuse('../hello.ts')).toMatchObject({ origin_ref: 'seat.write_paths' })
})

test('a plan on a real target is cloned from our fork and branched off upstream main', async () => {
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

test('a brief wholly under kotlin/ routes the build to the kotlin seat, and the diff is against the branch base', async () => {
  const w = world('warm', undefined, KOTLIN)
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  record(w.db, 1, [{ path: 'kotlin/build.gradle.kts', is_new: false }])
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
  expect(fired?.note).toMatch(/^kotlin_specialist /)
  expect(existsSync(join(srcDir(w.root, 1), 'kotlin/build.gradle.kts'))).toBe(true)
  const seen: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => seen.push(p)))
  expect(seen[0]?.prompt.split('# Diff')[1]?.trim()).toBe('')
})

test('a pipe fires only inside its window, wrapping across midnight', () => {
  expect(clock(new Date('2026-09-17T15:05:00Z'), -360)).toBe('09:05')
  expect(clock(new Date('2026-09-17T15:05:00Z'))).toBe('15:05')
  expect(inWindow(pipe({}), '09:00')).toBe(true)
  expect(inWindow(pipe({}), '08:59')).toBe(false)
  expect(inWindow(pipe({ window_start: '22:00', window_end: '02:00' }), '23:30')).toBe(true)
  expect(inWindow(pipe({ window_start: '22:00', window_end: '02:00' }), '12:00')).toBe(false)
})

test('a pipe at max_concurrent offers only the plans already running', () => {
  const plans = [row({ id: 1, state: 'running' }), row({ id: 2, state: 'queued' })]
  expect(underCap(pipe({ max_concurrent: 1 }), plans).map((p) => p.id)).toEqual([1])
  expect(underCap(pipe({ max_concurrent: 2 }), plans).map((p) => p.id)).toEqual([1, 2])
})

test('an off pipe fires nothing', async () => {
  const w = world()
  w.db.prepare('UPDATE pipes SET enabled = 0').run()
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
})

test('step 1 is blocked until cf approve target writes the row, and the plan records what it waits on', async () => {
  const w = world()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).step).toBe(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_approval')
  approve(w.db, w.target)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
})

test('a parked target holds its plan and says so in the row; a cold pulse alone holds nothing', async () => {
  const w = world('cold')
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_parked')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).wait_reason).toBe('target_parked')
  w.db.prepare("UPDATE targets SET state = 'ready' WHERE id = 1").run()
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('#140: the store takes only the reasons it lists', () => {
  const w = world('cold')
  expect(() => { waiting(w.db, [{ plan: 1, why: 'because i said so' as Wait }]) }).toThrow(/CHECK constraint/)
  expect(plan(w.db, 1).wait_reason).toBeNull()
})

test('old account evidence holds no plan; queueing still wants a fresh row, which cf queue add measures', () => {
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

test('cf measure refreshes the pulse the tick reads, without a second cf queue add', async () => {
  const w = world('warm', '2026-01-01')
  approve(w.db, w.target)
  expect(measure(w.db, 'acme/widget', '2026-09-17', measured('2026-09-17'))).toMatchObject({ pulse: 'warm', doors: 1 })
  expect(w.db.prepare('SELECT account_id FROM targets WHERE id = 1').get()).toEqual({ account_id: 1 })
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect((await tick(w.db, w.root, stub(CARRIED), new Date('2026-09-17T09:00:00Z')))[0]?.step).toBe(0)
  expect(plan(w.db, 1).step).toBe(1)
})

test('a rail refusal names spans, sends the plan back one step, then to blocked_on_ceo', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2]) {
    expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]?.step).toBe(step)
  }
  const first = (await tick(w.db, w.root, stub(UNPOINTED)))[0]
  expect(first).toMatchObject({ step: 3, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  await tick(w.db, w.root, stub(UNPOINTED))
  expect((await tick(w.db, w.root, stub(UNPOINTED)))[0]).toMatchObject({ step: 3, state: 'blocked_on_ceo' })
  expect(plan(w.db, 1).state).toBe('blocked_on_ceo')
  const verdict = w.db.prepare("SELECT outcome, origin_ref FROM verdicts WHERE rail_id = 'completion-audit' ORDER BY id").get()
  expect(verdict).toEqual({ outcome: 'refuse', origin_ref: 'completion-audit' })
})

test('the sequencer hands the bench a maintainer view, and a wrong shape refuses before any model', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2, 3]) expect((await tick(w.db, w.root, stub(CARRIED)))[0]?.step).toBe(step)
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 4, outcome: 'pass', state: 'running' })
  const row = w.db.prepare("SELECT gate, kind, outcome FROM verdicts WHERE step = 4").get()
  expect(row).toEqual({ gate: 'review', kind: 'review', outcome: 'pass' })
  const bare = benchPacket(w.root, 'code_quality', 'a handback is not a maintainer view', '/tmp/x.transcript.jsonl')
  expect(bare).toHaveProperty('refusal')
})

const planFile = (root: string, name: string): string => readFileSync(join(root, '.cf/work/1', name), 'utf8')

const PAIR = `${WORDS}\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n---\n`

test('a rebuild keeps the hand-back it was refused on and hands its rows to the builder', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(UNPOINTED))
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  expect(planFile(w.root, 'step-2.handback.prev.md')).toBe(UNPOINTED)
  expect(packets.find((p) => p.tools.includes('Write'))?.prompt)
    .toContain('done:\n  - id: D1\n    status: done\n    pointer:')
})

test('a review refusal returns the plan to build with every span the reviewer named, then escalates', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, PAIR)))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', state: 'retried' })
  expect(fired?.spans).toEqual(['src/hello.ts:1', 'src/parse.ts:3'])
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md'))
    .toBe(`step 4 review refused by code_quality\n\ncode_quality refuse\n\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n\n${WORDS}\n`)
  expect(planFile(w.root, 'step-4.verdict.md'))
    .toBe(`---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n  - src/parse.ts:3\n---\n\n${WORDS}\n`)

  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const second = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(second).toMatchObject({ step: 4, outcome: 'refuse', state: 'blocked_on_ceo' })
  expect(plan(w.db, 1)).toMatchObject({ step: 4, retries: 1, state: 'blocked_on_ceo' })
})

test('a new refusal after a real rebuild goes round again; the same one again stops', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect((await tick(w.db, w.root, stub(CARRIED, 0, PAIR)))[0]).toMatchObject({ step: 4, state: 'retried' })
  built(w.root, 1, 'export const two = (): number => 2')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect((await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]).toMatchObject({ step: 4, state: 'retried' })
  built(w.root, 1, 'export const three = (): number => 3')
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect((await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]).toMatchObject({ step: 4, state: 'blocked_on_ceo' })
  expect(planFile(w.root, 'refusal.md')).toContain('# Stopped\n\nthe same refusal came back')
})

/**
 * This round is on one of our own plans, not a stranger's. #87 landed after this test was written:
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
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, seen)
  const prompt = packets.find((p) => p.prompt.includes('\n# Diff\n'))?.prompt ?? ''
  expect(prompt).toContain('# Changed code in context')
  expect(prompt).toContain('# Files around the change')
  expect(prompt.indexOf('# Changed code in context')).toBeGreaterThan(prompt.indexOf('# Diff'))
  expect(prompt).not.toContain('# Checks')
})

test('a reviewer gets its own last verdict, the diff since the tree it judged and what did not move, neither on its first', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(join(srcDir(w.root, MINE), 'src/parse.ts'), 'export const parse = (): number => 1\n')
  const round1: Packet[] = []
  await tick(w.db, w.root, stub(OWNS, 0, REFUSE, (p) => round1.push(p)))
  expect(reviewer(round1)).not.toContain('# Your last verdict')
  expect(reviewer(round1)).not.toContain('# Changed code in context')
  expect(reviewer(round1)).not.toContain('# Checks')

  built(w.root, MINE, 'export const two = (): number => 2')
  const round2: Packet[] = []
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(OWNS, 0, PASS, (p) => round2.push(p)))
  const prompt = reviewer(round2)
  expect(prompt).toContain('# Checks\n\nPassed on this diff')
  expect(prompt).toContain(`# Your last verdict\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n---\n\n${WORDS}`)
  expect(prompt.split('# Changed since your last verdict')[1]).toContain('+export const two = (): number => 2')
  expect(prompt.split('# Paths since your last verdict')[1]).toMatch(
    new RegExp(`changed since the tree you judged:\n {2}- src/hello\\.ts\n\n`
      + `merged from main, not the builder's:\n {2}- none\n\n`
      + `unchanged since you judged it, at the blob it had then:\n {2}- src/parse\\.ts [0-9a-f]{40}`))
  const trees = w.db.prepare('SELECT tree FROM verdicts WHERE plan = ? AND step = 4 ORDER BY id').all(MINE) as { tree: string }[]
  expect(trees).toHaveLength(2)
  expect(trees.every((r) => /^[0-9a-f]{40}$/.test(r.tree))).toBe(true)
})

const HELLO = (word: string, back: string): string =>
  `export function hello(): string {\n  const a = "h"\n  const b = "i"\n  const c = ""\n  const d = ""\n  const word = ${word}\n  return ${back}\n}\n`

const section = (prompt: string, head: string): string => prompt.split(`\n# ${head}\n\n`)[1]?.split('\n\n# ')[0] ?? ''

test('a reviewer step 5 sent back is handed the delta since the tree it passed, in its function, with the refusal', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  const hello = join(srcDir(w.root, MINE), 'src/hello.ts')
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  writeFileSync(hello, HELLO('a + b', 'word + c + d'))
  for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS))
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE))
  const round = async (word: string, back: string): Promise<string> => {
    writeFileSync(hello, HELLO(word, back))
    const seen: Packet[] = []
    for (let step = 0; step < 3; step += 1) await tick(w.db, w.root, stub(CARRIED, 0, REFUSE, (p) => seen.push(p)))
    return reviewer(seen)
  }

  const prompt = await round('a + b + "!"', 'word + c + d')
  expect(section(prompt, 'Diff')).toContain('\n+  const c = ""\n')
  expect(section(prompt, 'Your last verdict')).toMatch(/^---\noutcome: pass\n/)
  expect(section(prompt, 'Refusal that sent the build back')).toMatch(/^step 5 /)
  expect(section(prompt, 'Refusal that sent the build back')).toContain(WORDS)
  const since = section(prompt, 'Changed since your last verdict')
  expect(since).toContain('\n export function hello(): string {\n')
  expect(since).toContain('\n+  const word = a + b + "!"\n')
  expect(section(prompt, 'Paths since your last verdict')).toContain('changed since the tree you judged:\n  - src/hello.ts\n')

  expect(section(await round('a + b + "!"', 'word'), 'Changed since your last verdict')).toContain('\n+  const word = a + b + "!"\n')
})

test('narrowing calls a moved path the plan does not touch main\'s, and proves the rest with its blob', () => {
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

test('a senior refusal lands on build too, and the ticks after it walk rails, review, senior', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 5; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired).toMatchObject({ step: 5, outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(planFile(w.root, 'refusal.md')).toContain(WORDS)

  const walked: string[] = []
  for (let at = 0; at < 4; at += 1) walked.push((await tick(w.db, w.root, stub(CARRIED)))[0]?.name ?? '')
  expect(walked).toEqual(['build', 'rails', 'review', 'senior'])
})

test('six ticks walk a plan from measure to Ready on one seat run and no tokens spent deciding', async () => {
  const w = world()
  approve(w.db, w.target)
  const walked: string[] = []
  for (const at of [0, 1, 2, 3, 4, 5]) {
    const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
    expect(fired).toMatchObject({ step: at, outcome: 'pass' })
    walked.push(fired?.name ?? '')
  }
  expect(walked).toEqual(['measure', 'ruling', 'build', 'rails', 'review', 'senior'])
  expect(plan(w.db, 1).step).toBe(6)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
  expect(w.db.prepare("SELECT count(*) AS n FROM runs WHERE seat = 'outside_specialist'").get()).toEqual({ n: 1 })
})

test('step 6 sends the branch to our fork, waits out a run still going, then records ci-green and ready', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const sent: string[] = []

  const held = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched(sent, w.root, 1, runsOn(w.root, 1, 'in_progress'))))[0]
  expect(held).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(held?.spans).toEqual([`${RUN} ci.pending`])
  expect(sent).toEqual(['send src widget-12-a1', 'rehearse caliperforge/widget widget-12-a1'])
  expect(plan(w.db, 1).step).toBe(6)
  expect(w.db.prepare("SELECT count(*) AS n FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ n: 0 })

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent, w.root, 1)))[0]
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(sent).toHaveLength(4)
  expect(w.db.prepare('SELECT rail_id, gate, outcome FROM verdicts WHERE plan = 1 AND step = 6 ORDER BY id').all())
    .toEqual([{ rail_id: 'ci-green', gate: 'ready', outcome: 'pass' }, { rail_id: 'ready', gate: 'ready', outcome: 'pass' }])
})

test('a red run on the fork sends the plan to the builder with the failed log', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const red = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))))[0]
  expect(red).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 2, retries: 1 })
  expect(red?.spans[0]).toMatch(/^ci\.red /)
  expect(planFile(w.root, 'refusal.md')).toContain('their CI is red')
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ outcome: 'refuse' })
})

test('a fork still red after a rebuild that changed nothing stops instead of cycling', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))
  const lap = async (): Promise<string | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.state

  expect(await lap()).toBe('retried')
  expect(plan(w.db, 1).step).toBe(2)
  for (let at = 0; at < 4; at += 1) await lap()
  expect(plan(w.db, 1).step).toBe(6)
  expect(await lap()).toBe('blocked_on_ceo')
})

test('a run still going is waited on past the first-run window', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const wire = watched([], w.root, 1, runsOn(w.root, 1, 'in_progress', ''))
  let last
  for (let at = 0; at < 11; at += 1) last = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(last).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(last?.note).toMatch(/is still running CI, tick 11 of 45/)
  expect(w.db.prepare("SELECT count(*) AS n FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ n: 0 })
})

test('the push window is waited out: no run at the new head holds step 6, the run that appears is judged', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const sent: string[] = []
  const wire = watched(sent, w.root, 1, runsAfter(w.root, 1, 2))

  const first = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(first).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(first?.spans[0]).toMatch(/ ci\.missing$/)
  expect(first?.note).toMatch(/no run yet, tick 1 of 10/)
  expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.note).toMatch(/tick 2 of 10/)
  expect(w.db.prepare("SELECT count(*) AS n FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ n: 0 })
  expect(plan(w.db, 1).step).toBe(6)

  const judged = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(judged).toMatchObject({ step: 6, name: 'ready', outcome: 'pass' })
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ outcome: 'pass' })
  expect(plan(w.db, 1).step).toBe(7)
  expect(sent).toHaveLength(6)
})

test('a head still runless after the window is refused on ci-green, not waited on forever', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const wire = watched([], w.root, 1, () => '[]')
  for (let at = 0; at < 10; at += 1) {
    expect((await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0])
      .toMatchObject({ step: 6, outcome: 'pass', state: 'running' })
  }

  const out = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]
  expect(out).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ outcome: 'refuse' })
  expect(plan(w.db, 1).step).toBe(5)
})

test('step 6 refuses a plan with no deliverable row instead of sending the branch and raising', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  w.db.prepare('DELETE FROM deliverables WHERE plan_id = 1').run()
  const sent: string[] = []

  expect(kernel(w.db, w.root, plan(w.db, 1), watched(sent, w.root, 1)))
    .toMatchObject({ outcome: 'refuse', spans: ['deliverables'] })
  expect(sent).toEqual([])
})

test('every run row points at a transcript the provider wrote', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const rows = w.db.prepare('SELECT seat, step, transcript_path FROM runs ORDER BY id').all() as
    { seat: string; step: number; transcript_path: string }[]
  expect(rows.map((r) => r.step)).toEqual([1, 2, 4, 5])
  for (const r of rows) {
    expect(r.transcript_path).toMatch(/\.transcript\.jsonl$/)
    expect(existsSync(r.transcript_path)).toBe(true)
  }
})

test('pr-path is measure to push, 0 to 8, and every gate step writes a verdict', () => {
  expect(steps.map((s) => s.name)).toEqual(['measure', 'ruling', 'build', 'rails', 'review', 'senior', 'ready', 'batch', 'push'])
  expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(steps.filter((s) => s.gate && !s.writes_verdict)).toEqual([])
  expect(steps.filter((s) => s.writes_verdict).map((s) => s.verdict_gate))
    .toEqual(['pre_review', 'review', 'senior_review', 'ready'])
  expect(at(1, 'kotlin')).toMatchObject({ seat: 'brief_writer', runs: 'brief_writer' })
  expect(at(2, 'kotlin')).toMatchObject({ seat: 'kotlin_specialist', runs: 'kotlin_specialist' })
})

test('the ticket ids a rail expects come off the issue, falling back to D1', () => {
  expect(doneIds('- **D1** one\n- **D2** two\n')).toEqual(['D1', 'D2'])
  expect(doneIds('no conditions here')).toEqual(['D1'])
  expect(parse('acme/widget', 'https://github.com/acme/widget/issues/12')).toBe(12)
  expect(() => parse('acme/widget', 'https://example.com/12')).toThrow(/not a github issue url/)
  expect(() => parse('acme/widget', 'https://github.com/other/repo/issues/12')).toThrow(/not acme\/widget/)
})

test('cf brief and cf plan bind the plan they are asked for', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2, 3]) expect((await tick(w.db, w.root, stub(CARRIED)))[0]?.step).toBe(step)
  expect(runsOf(w.db, 1).map((r) => r.step)).toEqual([1, 2])
  expect(runsOf(w.db, 99)).toEqual([])
  expect(verdictsOf(w.db, 1).map((v) => v.gate)).toEqual(Array<string>(6).fill('pre_review'))
  expect(w.db.prepare('SELECT rail_id FROM verdicts WHERE plan = 1 ORDER BY id').all().map((r) => (r as { rail_id: string }).rail_id))
    .toEqual(['completion-audit', 'secret-scan', 'authority', 'tight', 'test-weakened', 'identifiers'])
  expect(verdictsOf(w.db, 99)).toEqual([])
  expect(openPlans(w.db).map((p) => p.id)).toEqual([1])
  expect(halted(w.db)).toEqual([])
  expect(day(w.db)).toMatchObject({ runs: 2, tokens: 120 })
})

test('a builder names a file for deletion and the kernel removes it before the rails read the tree', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
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

test('a deletion outside the fence refuses the build and names the path', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(dropping(['src/elsewhere.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['src/elsewhere.ts'] })
  expect(fired?.note).toContain('outside the fence')
  expect(existsSync(join(srcDir(w.root, 1), 'src/hello.ts'))).toBe(true)
})

test('a deletion of a path that is not in the tree refuses rather than passing as a no-op', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))

  const fired = (await tick(w.db, w.root, stub(dropping(['src/never-was.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'refuse', spans: ['src/never-was.ts'] })
  expect(fired?.note).toContain('is not in the tree')
})

test('the same path named twice is deleted once, not refused the second time as absent', async () => {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, MINE)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const src = srcDir(w.root, MINE)
  writeFileSync(join(src, 'src/twice.ts'), 'export const twice = 1\n')

  const fired = (await tick(w.db, w.root, stub(dropping(['src/twice.ts', 'src/twice.ts']))))[0]

  expect(fired).toMatchObject({ step: 2, outcome: 'pass' })
  expect(existsSync(join(src, 'src/twice.ts'))).toBe(false)
})
