import { expect, test } from 'vitest'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { account, parse } from '../../cli/queue.ts'
import { clock, inWindow, underCap, type PipeRow, type PlanRow } from '../../store/plans.ts'
import { steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { blocked } from '../steps.ts'
import { doneIds } from '../workspace.ts'
import { approve, bench, plan, stub, world } from './world.ts'

const CARRIED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer: src/hello.ts:1\n---\n'
const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0, ...over })

test('a pipe fires only inside its window, wrapping across midnight', () => {
  expect(clock(new Date(2026, 8, 17, 9, 5))).toBe('09:05')
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
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toBeNull()
})

test('a cold pulse parks the plan at measure and never refuses it', async () => {
  const w = world('cold')
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toMatch(/parked on a cold pulse/)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(plan(w.db, 1).state).toBe('queued')
})

test('an accounts row older than 30 days blocks the plan and refuses the queue', async () => {
  const w = world('warm', '2026-01-01')
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toMatch(/days old, re-measure/)
  expect(await tick(w.db, w.root, stub(CARRIED), new Date('2026-09-17T09:00:00Z'))).toEqual([])
  expect(() => account(w.db, 'acme/widget', '2026-09-17')).toThrow(/re-measure before queueing/)
  expect(() => account(w.db, 'acme/other', '2026-09-17')).toThrow(/no accounts row/)
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

test('an absent review bench stops the plan at needs_ceo naming the span it cannot reach', async () => {
  const w = world()
  approve(w.db, w.target)
  for (const step of [0, 1, 2, 3]) expect((await tick(w.db, w.root, stub(CARRIED)))[0]?.step).toBe(step)
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'needs_ceo', state: 'blocked_on_ceo' })
  expect(fired?.note).toMatch(/reviews\/code_quality is not in the tree/)
})

test('six ticks walk a plan from measure to Ready on one seat run and no tokens spent deciding', async () => {
  const w = world()
  approve(w.db, w.target)
  bench(w.root)
  const walked: string[] = []
  for (const step of [0, 1, 2, 3, 4, 5]) {
    const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
    expect(fired).toMatchObject({ step, outcome: 'pass' })
    walked.push(fired?.name ?? '')
  }
  expect(walked).toEqual(['measure', 'ruling', 'build', 'rails', 'review', 'senior'])
  expect(plan(w.db, 1).step).toBe(6)
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toBe('awaiting the ready proof')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(w.db.prepare('SELECT count(*) AS n, sum(input_tokens + cache_tokens + output_tokens) AS t FROM runs').get())
    .toEqual({ n: 1, t: 60 })
})

test('pr-path is measure to batch, 0 to 7, and every gate step writes a verdict', () => {
  expect(steps.map((s) => s.name)).toEqual(['measure', 'ruling', 'build', 'rails', 'review', 'senior', 'ready', 'batch'])
  expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(steps.filter((s) => s.gate && !s.writes_verdict)).toEqual([])
  expect(steps.filter((s) => s.writes_verdict).map((s) => s.verdict_gate))
    .toEqual(['pre_review', 'review', 'senior_review', 'ready'])
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
  expect(runsOf(w.db, 1).map((r) => r.step)).toEqual([2])
  expect(runsOf(w.db, 99)).toEqual([])
  expect(verdictsOf(w.db, 1).map((v) => v.gate)).toEqual(['pre_review'])
  expect(verdictsOf(w.db, 99)).toEqual([])
  expect(openPlans(w.db).map((p) => p.id)).toEqual([1])
  expect(halted(w.db)).toEqual([])
  expect(day(w.db)).toMatchObject({ runs: 1, tokens: 60 })
})
