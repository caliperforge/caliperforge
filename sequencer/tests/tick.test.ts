import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { day, halted, open as openPlans, runsOf, verdictsOf } from '../../cli/brief.ts'
import { measure, type Read } from '../../cli/measure.ts'
import { account, parse } from '../../cli/queue.ts'
import { clock, inWindow, underCap, type PipeRow, type PlanRow } from '../../store/plans.ts'
import { steps } from '../../templates/pr-path.ts'
import { tick } from '../index.ts'
import { blocked } from '../steps.ts'
import { doneIds, srcDir } from '../workspace.ts'
import { benchPacket } from '../../runner/packet.ts'
import type { Packet } from '../../providers/kind.ts'
import { approve, CARRIED, KOTLIN, PASS, plan, REFUSE, stub, world } from './world.ts'

const head = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const UNPOINTED = 'built\n\n---\ndone:\n  - id: D1\n    status: done\n    pointer:\n---\n'
const pipe = (over: Partial<PipeRow>): PipeRow =>
  ({ id: 1, name: 'pr-path', enabled: 1, window_start: '09:00', window_end: '17:00', max_concurrent: 1, ...over })
const row = (over: Partial<PlanRow>): PlanRow =>
  ({ id: 1, pipe_id: 1, target_id: 1, template: 'pr_path', state: 'queued', queued_at: '', step: 0, retries: 0,
    head_digest: null, ...over })

test('the builder works in the checkout and may write only inside its write_paths', async () => {
  const w = world()
  approve(w.db, w.target)
  const packets: Packet[] = []
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED, 0, PASS, (p) => packets.push(p)))
  const builder = packets[0]
  expect(builder).toBeDefined()
  const src = realpathSync(srcDir(w.root, 1))
  expect(builder?.cwd).toBe(srcDir(w.root, 1))
  expect(builder?.refuse(join(src, 'src/hello.ts'))).toBeNull()
  expect(builder?.refuse('src/nested/hello.ts')).toBeNull()
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

test('a kotlin checkout routes the build to the kotlin seat, and the diff is against the branch base', async () => {
  const w = world('warm', undefined, KOTLIN)
  approve(w.db, w.target)
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
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

/** The three `gh` shapes `cf measure` parses, canned: one outsider merge that day, one open pr, one other repo. */
const measured = (day: string): Read => (args) => {
  if (args[0] === 'search') return [{ repository: { nameWithOwner: 'acme/other' } }]
  if (args.includes('createdAt')) return [{ createdAt: `${day}T00:00:00Z` }]
  return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: `${day}T00:00:00Z` }]
}

test('cf measure refreshes the pulse the tick reads, without a second cf queue add', async () => {
  const w = world('warm', '2026-01-01')
  approve(w.db, w.target)
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toMatch(/days old, re-measure/)
  expect(measure(w.db, 'acme/widget', '2026-09-17', measured('2026-09-17'))).toMatchObject({ pulse: 'warm', doors: 1 })
  expect(w.db.prepare('SELECT account_id FROM targets WHERE id = 1').get()).toEqual({ account_id: 1 })
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toBeNull()
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

test('a reviewer refusal carries its spans to the builder instead of dropping them', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 4; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, REFUSE)))[0]
  expect(fired).toMatchObject({ step: 4, outcome: 'refuse', state: 'retried' })
  expect(fired?.spans).toEqual(['src/hello.ts:1'])
  expect(readFileSync(join(w.root, '.cf/work/1/refusal.md'), 'utf8')).toMatch(/src\/hello\.ts:1/)
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
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toBe('awaiting the ready proof')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(w.db.prepare("SELECT count(*) AS n FROM runs WHERE seat = 'typescript_specialist'").get()).toEqual({ n: 1 })
})

test('step 6 refuses until ci-green has left a verdict, then fires the ready rail and records it', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, 1).step).toBe(6)
  expect(blocked(w.db, plan(w.db, 1), '2026-09-17')).toBe('awaiting the ready proof')
  w.db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass,
    byte_identical_elsewhere, fork_ci_green, bot_clean, target_warm, evidence)
    VALUES (1, 2, 'typescript_specialist', ?, 'gated', 1, 1, 1, 1, 1, 'https://github.com/acme/widget/pull/1')`)
    .run('b'.repeat(64))
  const blind = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(blind).toMatchObject({ step: 6, name: 'ready', outcome: 'refuse' })
  expect(blind?.spans).toEqual(['ci-green'])
  w.db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, tokens, seconds)
    VALUES ('ready', 'rail', ?, 1, 6, 'pass', 'ci-green', 0, 0)`).run('c'.repeat(64))
  w.db.prepare("UPDATE plans SET step = 6, state = 'running' WHERE id = 1").run()
  const fired = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(fired).toMatchObject({ step: 6, name: 'ready', outcome: 'pass', state: 'running' })
  expect(w.db.prepare("SELECT gate, kind, outcome FROM verdicts WHERE rail_id = 'ready' ORDER BY id").all())
    .toEqual([{ gate: 'ready', kind: 'rail', outcome: 'refuse' }, { gate: 'ready', kind: 'rail', outcome: 'pass' }])
})

test('every run row points at a transcript the provider wrote', async () => {
  const w = world()
  approve(w.db, w.target)
  for (let at = 0; at < 6; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const rows = w.db.prepare('SELECT seat, step, transcript_path FROM runs ORDER BY id').all() as
    { seat: string; step: number; transcript_path: string }[]
  expect(rows.map((r) => r.step)).toEqual([2, 4, 5])
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
  expect(verdictsOf(w.db, 1).map((v) => v.gate)).toEqual(Array<string>(6).fill('pre_review'))
  expect(w.db.prepare('SELECT rail_id FROM verdicts WHERE plan = 1 ORDER BY id').all().map((r) => (r as { rail_id: string }).rail_id))
    .toEqual(['completion-audit', 'secret-scan', 'authority', 'tight', 'test-weakened', 'identifiers'])
  expect(verdictsOf(w.db, 99)).toEqual([])
  expect(openPlans(w.db).map((p) => p.id)).toEqual([1])
  expect(halted(w.db)).toEqual([])
  expect(day(w.db)).toMatchObject({ runs: 1, tokens: 60 })
})
