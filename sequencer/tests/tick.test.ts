import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { measure, type Read } from '../../cli/measure.ts'
import { account, parse } from '../../cli/queue.ts'
import { clock, inWindow, underCap, type PipeRow, type PlanRow } from '../../store/plans.ts'
import { at, steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { blocked, kernel } from '../steps.ts'
import { doneIds, srcDir } from '../workspace.ts'
import { record } from '../../store/files.ts'
import { benchPacket } from '../../runner/packet.ts'
import type { Packet } from '../../providers/kind.ts'
import { approve, built, CARRIED, KOTLIN, PASS, plan, redLaps, REFUSE, RUN, runsAfter, runsOn, stub, watched, WORDS, world } from './world.ts'

const head = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0,
    head_digest: null, priority: 1, lane: null, seat: null, origin: null, ...over })

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

test('step 1 is blocked until cf approve target writes the row', async () => {
  const w = world()
  expect(await tick(w.db, w.root, stub(CARRIED))).toHaveLength(1)
  expect(plan(w.db, 1).step).toBe(1)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  approve(w.db, w.target)
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
})

test('a parked target holds its plan; a cold pulse alone holds nothing', async () => {
  const w = world('cold')
  expect(blocked(w.db, plan(w.db, 1))).toMatch(/is parked/)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  w.db.prepare("UPDATE targets SET state = 'ready' WHERE id = 1").run()
  expect(blocked(w.db, plan(w.db, 1))).toBeNull()
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

test('a reviewer gets its own last verdict and the diff since it from its second round on, neither on its first', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let step = 0; step < 4; step += 1) await tick(w.db, w.root, stub(CARRIED))
  const round1: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, REFUSE, (p) => round1.push(p)))
  expect(round1[0]?.prompt).not.toContain('# Your last verdict')

  built(w.root, 1, 'export const two = (): number => 2')
  for (let step = 0; step < 2; step += 1) await tick(w.db, w.root, stub(CARRIED))
  const round2: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => round2.push(p)))
  const prompt = round2[0]?.prompt ?? ''
  expect(prompt).toContain(`# Your last verdict\n\n---\noutcome: refuse\nclass: correctness\nspans:\n  - src/hello.ts:1\n---\n\n${WORDS}`)
  expect(prompt.split('# Changed since your last verdict')[1]).toContain('+export const two = (): number => 2')
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
  expect(sent).toEqual(['send src widget-12-a1'])
  expect(plan(w.db, 1).step).toBe(6)
  expect(w.db.prepare("SELECT count(*) AS n FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ n: 0 })

  const fired = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched(sent, w.root, 1)))[0]
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(sent).toHaveLength(2)
  expect(w.db.prepare('SELECT rail_id, gate, outcome FROM verdicts WHERE plan = 1 AND step = 6 ORDER BY id').all())
    .toEqual([{ rail_id: 'ci-green', gate: 'ready', outcome: 'pass' }, { rail_id: 'ready', gate: 'ready', outcome: 'pass' }])
})

test('a red run on the fork refuses the ready gate on the rail and sends the plan back', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const red = (await tick(w.db, w.root, stub(CARRIED), undefined, undefined,
    watched([], w.root, 1, runsOn(w.root, 1, 'completed', 'failure'))))[0]
  expect(red).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse', state: 'retried' })
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 1 })
  expect(red?.spans).toEqual(['ci-green', 'fork:1 not.public'])
  expect(w.db.prepare("SELECT outcome FROM verdicts WHERE plan = 1 AND rail_id = 'ci-green'").get())
    .toEqual({ outcome: 'refuse' })
})

test('a fork that stays red escalates on the second strike instead of cycling 6 -> 5 -> 6', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const wire = watched([], w.root, 1, redLaps(w.root, 1))
  const lap = async (): Promise<string | undefined> => (await tick(w.db, w.root, stub(CARRIED), undefined, undefined, wire))[0]?.state

  expect(await lap()).toBe('running')
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 0 })
  expect(await lap()).toBe('retried')
  expect(plan(w.db, 1)).toMatchObject({ step: 5, retries: 1 })
  expect(await lap()).toBe('running')

  expect(await lap()).toBe('running')
  expect(plan(w.db, 1)).toMatchObject({ step: 6, retries: 1 })
  expect(await lap()).toBe('blocked_on_ceo')
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
  expect(sent).toHaveLength(3)
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
