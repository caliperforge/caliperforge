import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { homeOf } from '../../sequencer/home.ts'
import { dry } from '../../sequencer/index.ts'
import { get, git, planDir, put, srcDir } from '../../sequencer/workspace.ts'
import { record } from '../../store/bench.ts'
import { addRun } from '../../store/brief.ts'
import { eventsAfter, logged, ofKind } from '../../store/events.ts'
import { type Db, upsertRule } from '../../store/index.ts'
import { dial, lanes, set } from '../../store/lanes.ts'
import { allPlans, holderOf, openPipes, pipeNamed, planById, planTitle, putPlan, type PlanRow } from '../../store/plans.ts'
import { fingerprint, refused as refuse } from '../../store/refusals.ts'
import { runTokens, spend } from '../../store/runs.ts'
import { dried } from '../../templates/dry.ts'
import { credit, fileBench, medusaFile, refuzz, rescore } from '../bench.ts'
import { laneLine } from '../brief.ts'
import type { Read } from '../gh.ts'
import { add } from '../plan.ts'

const schema = join(import.meta.dirname, '../../schema')
const BENCH = 'https://github.com/caliperforge/fuzz-bench/issues/1'
const OURS = 'https://github.com/caliperforge/caliperforge/issues/25'

const canned = (url: string): Read => () =>
  ({ number: Number(url.split('/').at(-1)), title: 'Bench the fuzzers', body: 'the ask', url, labels: [{ name: 'lane:bench' }] })

const root = (): string => mkdtempSync(join(tmpdir(), 'cf-bench-'))

const row = (lane: string): string => `INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin)
  VALUES ((SELECT id FROM pipes WHERE name = 'bench'), 'pr_path', 'queued', '2026-10-13', '${lane}', 'solidity_specialist', '${BENCH}')`

test('D2 plans table takes the bench lane and no unlisted lane', () => {
  expect(rejects(fresh(schema), row('bench'))).toBe(false)
  expect(rejects(fresh(schema), row('solana'))).toBe(true)
})

test('D3 the bench pipe ships on, all day, two wide', () => {
  const d = fresh(schema)
  expect(pipeNamed(d, 'bench')).toMatchObject({ enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 2 })
  expect(openPipes(d, '03:00').map((p) => p.name)).toContain('bench')
})

test('D4 fuzz-bench: bench lane, pipe, solidity seat, home', () => {
  const d = fresh(schema)
  const filed = add(d, root(), 'caliperforge/fuzz-bench#1', 'ceo', undefined, canned(BENCH))
  expect(filed).toMatchObject({ state: 'queued', lane: 'bench', seat: 'solidity_specialist' })
  const plan = planById(d, Number(filed.plan))
  expect(plan.pipe_id).toBe(pipeNamed(d, 'bench')?.id)
  expect(homeOf(plan)).toBe('caliperforge/fuzz-bench')
})

test('D5 a bench issue off fuzz-bench is refused', () => {
  const filed = add(fresh(schema), root(), 'caliperforge/caliperforge#25', 'ceo', undefined, canned(OURS))
  expect(filed.state).toBe('refused')
  expect(filed.why).toContain('the bench lane builds in caliperforge/fuzz-bench')
})

test('D7 brief counts the bench pipe at 03:00', () => {
  const d = fresh(schema)
  dial(d, 1, '2026-10-13')
  expect(laneLine(lanes(d, '03:00'))).toMatch(/^lanes 0\/2 live\/open/)
})

const AT = '2026-09-18T13:00:00.000Z'
const YML = 'repo: euler-xyz/euler-earn\nfix: abc123\n'

function benchRoot(): string {
  const dir = root()
  for (const sub of ['rules', 'seats']) cpSync(join(import.meta.dirname, '../..', sub), join(dir, sub), { recursive: true })
  const bench = join(dir, 'remotes/caliperforge/fuzz-bench')
  mkdirSync(join(bench, 'targets'), { recursive: true })
  writeFileSync(join(bench, 'targets/euler-earn-m01.yml'), YML)
  writeFileSync(join(bench, 'targets/smoke-01.yml'), 'repo: org/smoke\n')
  git(bench, ['init', '-q'])
  git(bench, ['add', '-A'])
  git(bench, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'targets'])
  mkdirSync(join(dir, '.cf'))
  writeFileSync(join(dir, '.cf/git-base'), join(dir, 'remotes'))
  return dir
}

test('file D1 one target queues a bench plan dry lists at step 0', () => {
  const dir = benchRoot()
  const d = fresh(schema)
  dial(d, 3, AT)
  const ids = fileBench(d, dir, 'euler-earn-m01', false, 'fizz_generator', AT)
  expect(ids).toHaveLength(1)
  const id = Number(ids[0])
  expect(planById(d, id)).toMatchObject({ template: 'bench', state: 'queued', step: 0, pipe_id: pipeNamed(d, 'bench')?.id })
  expect(dry(d, new Date(AT)).would).toContainEqual({ pipe: 'bench', plan: id, step: 0, template: 'bench' })
  expect(get(dir, id, 'target.yml')).toBe(`${YML}target: euler-earn-m01\ngenerator: fizz\n`)
  expect(planTitle(d, id)).toBe('Bench: score fizz on euler-earn-m01 (catch / miss / false alarm)')
})

test('file D2 --all files one plan per target yml', () => {
  const dir = benchRoot()
  const d = fresh(schema)
  const ids = fileBench(d, dir, undefined, true, 'fizz_generator', AT)
  expect(ids.map((id) => get(dir, id, 'target.yml'))).toEqual([`${YML}target: euler-earn-m01\ngenerator: fizz\n`,
    'repo: org/smoke\ntarget: smoke-01\ngenerator: fizz\n'])
  expect(ids.map((id) => planTitle(d, id))).toEqual(['Bench: score fizz on euler-earn-m01 (catch / miss / false alarm)',
    'Bench: score fizz on smoke-01 (catch / miss / false alarm)'])
})

test('file D3 an unknown target is refused and files nothing', () => {
  const d = fresh(schema)
  expect(() => fileBench(d, benchRoot(), 'nope', false, 'fizz_generator', AT)).toThrow('fuzz-bench has no targets/nope.yml')
  expect(allPlans(d)).toEqual([])
})

function noSuite(): { dir: string; d: Db; plan: number } {
  const dir = benchRoot()
  const d = fresh(schema)
  const plan = Number(fileBench(d, dir, 'smoke-01', false, 'fizz_generator', AT)[0])
  refuse(d, { plan, step: 1, fingerprint: fingerprint(1, ['bench.no_suite']), diff: null, span: 'bench.no_suite' })
  return { dir, d, plan }
}

test('file D1 a bench.no_suite target is refused by name', () => {
  const { dir, d, plan } = noSuite()
  expect(() => fileBench(d, dir, 'smoke-01', false, 'fizz_generator', AT)).toThrow(`plan ${String(plan)}`)
  expect(allPlans(d)).toHaveLength(1)
})

test('file D2 --all leaves out a bench.no_suite target', () => {
  const { dir, d } = noSuite()
  const ids = fileBench(d, dir, undefined, true, 'fizz_generator', AT)
  expect(ids.map((id) => get(dir, id, 'target.yml'))).toEqual([`${YML}target: euler-earn-m01\ngenerator: fizz\n`])
})

test('file D3 another generator still files a no_suite target', () => {
  const { dir, d } = noSuite()
  expect(fileBench(d, dir, 'smoke-01', false, 'house_generator', AT)).toHaveLength(1)
})

test.each([['nope', 'fizz_lean_generator'], ['invariants', 'fizz_lean_generator'], ['invariants', 'fizz_lean_v5'], ['context', 'fizz_generator']])('file D5 --stop-after %s on %s is refused', (stop, seat) => {
  const d = fresh(schema)
  expect(() => fileBench(d, benchRoot(), 'euler-earn-m01', false, seat, AT, stop))
    .toThrow('--stop-after takes one of context, scaffold, coverage on fizz_lean_generator')
  expect(allPlans(d)).toEqual([])
})

test('file D5 --stop-after context lands in target.yml', () => {
  const dir = benchRoot()
  const id = Number(fileBench(fresh(schema), dir, 'euler-earn-m01', false, 'fizz_lean_generator', AT, 'context')[0])
  expect(get(dir, id, 'target.yml')).toBe(`${YML}target: euler-earn-m01\ngenerator: fizz_lean\nstop_after: context\n`)
})

test('file records bench.report_only_checks in target.yml', () => {
  const [dir, d] = [benchRoot(), fresh(schema)]
  set(d, 'bench.report_only_checks', ' suite.outside, reach.unmet,,reach.boundary', 'ceo', AT)
  const id = Number(fileBench(d, dir, 'euler-earn-m01', false, 'fizz_lean_generator', AT, 'context')[0])
  expect(get(dir, id, 'target.yml'))
    .toBe(`${YML}target: euler-earn-m01\ngenerator: fizz_lean\nstop_after: context\nreport_only_checks: suite.outside,reach.unmet,reach.boundary\n`)
})

test('file refuses an unlisted report-only check, files nothing', () => {
  const d = fresh(schema)
  set(d, 'bench.report_only_checks', 'suite.outside,suite.clamped', 'ceo', AT)
  expect(() => fileBench(d, benchRoot(), 'euler-earn-m01', false, 'fizz_generator', AT))
    .toThrow('bench.report_only_checks takes suite.outside, reach.unmet, reach.boundary, not suite.clamped')
  expect(allPlans(d)).toEqual([])
})

/** A fizz_lean_generator plan on smoke-01 whose regrades end in `outcomes`. */
function regraded(...outcomes: ('pass' | 'refuse')[]): { dir: string; d: Db; plan: number } {
  const dir = benchRoot()
  const d = fresh(schema)
  const plan = Number(fileBench(d, dir, 'smoke-01', false, 'fizz_lean_generator', AT)[0])
  for (const outcome of outcomes) logged(d, { plan, kind: 'bench.regrade', actor: 'bench', outcome, message: 'regraded', pointer: null, run: null })
  return { dir, d, plan }
}

test.each<{ outcomes: ('pass' | 'refuse')[] }>([{ outcomes: [] }, { outcomes: ['pass', 'refuse'] }])('lean file is refused after regrades $outcomes', ({ outcomes }) => {
  const { dir, d, plan } = regraded(...outcomes)
  const why = `smoke-01: plan ${String(plan)} has no clean regrade; run cf bench regrade ${String(plan)} or file with --why`
  expect(() => fileBench(d, dir, 'smoke-01', false, 'fizz_lean_generator', AT)).toThrow(why)
  expect(() => fileBench(d, dir, undefined, true, 'fizz_lean_generator', AT)).toThrow(why)
  expect(allPlans(d)).toHaveLength(1)
})

test('lean file --why files and logs one waiver per plan', () => {
  const { dir, d } = regraded()
  const ids = fileBench(d, dir, undefined, true, 'fizz_lean_generator', AT, undefined, 'regrade is down')
  expect(ids).toHaveLength(2)
  expect(ofKind(d, 'bench.regrade_waived')).toEqual(ids.map((plan) => ({ plan, kind: 'bench.regrade_waived', actor: 'coo', outcome: 'pass', message: 'regrade is down' })))
})

test('file --generator fizz_lean_v5 queues a v5 plan', () => {
  const dir = benchRoot()
  const d = fresh(schema)
  const plan = Number(fileBench(d, dir, 'euler-earn-m01', false, 'fizz_lean_v5', AT)[0])
  expect(planById(d, plan)).toMatchObject({ template: 'bench', state: 'queued', step: 0 })
  expect(get(dir, plan, 'target.yml')).toBe(`${YML}target: euler-earn-m01\ngenerator: fizz_lean_v5\n`)
  expect(planTitle(d, plan)).toBe('Bench: score fizz_lean_v5 on euler-earn-m01 (catch / miss / false alarm)')
  logged(d, { plan, kind: 'bench.regrade', actor: 'bench', outcome: 'refuse', message: 'regraded', pointer: null, run: null })
  expect(() => fileBench(d, dir, 'euler-earn-m01', false, 'fizz_lean_v5', AT))
    .toThrow(`euler-earn-m01: plan ${String(plan)} has no clean regrade; run cf bench regrade ${String(plan)} or file with --why`)
  expect(allPlans(d)).toHaveLength(1)
})

test('a clean regrade or a first run files, other seats ungated', () => {
  const { dir, d } = regraded('refuse', 'pass')
  expect(fileBench(d, dir, undefined, true, 'fizz_lean_generator', AT)).toHaveLength(2)
  for (const seat of ['fizz_generator', 'house_generator']) {
    fileBench(d, dir, 'smoke-01', false, seat, AT)
    expect(fileBench(d, dir, 'smoke-01', false, seat, AT)).toHaveLength(1)
  }
  expect(ofKind(d, 'bench.regrade_waived')).toEqual([])
})

const SCORED = 'fuzz-bench/suites/fizz/euler-earn-m01'

const ROW = { plan: 1, target: 'euler-earn-m01', generator: 'fizz', catches: 0, false_positives: 0, untested: null, tokens: 1, seconds: 1, x_ray: null,
  pre_fix_calls: null, fix_calls: null, not_powered: null, gross_usd: 0, net_usd: 0 }

/** A plan with its generate.json, target.yml and scored suite, and a live scorecard row. */
function rescorable(state: PlanRow['state'] = 'done', template: PlanRow['template'] = 'bench'): { dir: string; d: Db } {
  const dir = root()
  const d = fresh(schema)
  putPlan(d, { id: 1, pipe_id: Number(pipeNamed(d, 'bench')?.id), target_id: null, template, state, queued_at: AT, step: 4, retries: 0 })
  put(dir, 1, 'target.yml', `${YML}target: euler-earn-m01\ngenerator: fizz\n`)
  put(dir, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1, seconds: 1 }))
  mkdirSync(join(planDir(dir, 1), SCORED), { recursive: true })
  record(d, ROW)
  return { dir, d }
}

function refused(dir: string, d: Db, why: string): void {
  const before = planById(d, 1)
  expect(() => rescore(d, dir, 1, 'coo', 'error rows')).toThrow(why)
  expect(planById(d, 1)).toEqual(before)
  expect(ofKind(d, 'rescore')).toEqual([])
  expect(() => record(d, ROW)).toThrow(/UNIQUE/)
  expect(existsSync(join(planDir(dir, 1), 'src'))).toBe(false)
}

test('rescore D3 a non-bench plan is refused untouched', () => {
  const { dir, d } = rescorable('done', 'research')
  refused(dir, d, 'plan 1 is not a done bench plan')
})

test('rescore D3 a bench plan not done is refused untouched', () => {
  const { dir, d } = rescorable('running')
  refused(dir, d, 'plan 1 is not a done bench plan')
})

test('rescore D3 no generate.json is refused untouched', () => {
  const { dir, d } = rescorable()
  rmSync(join(planDir(dir, 1), 'generate.json'))
  refused(dir, d, 'plan 1 has no generate.json')
})

test('rescore D3 no scored suite is refused untouched', () => {
  const { dir, d } = rescorable()
  rmSync(join(planDir(dir, 1), SCORED), { recursive: true })
  refused(dir, d, 'plan 1 has no fuzz-bench/suites/fizz/euler-earn-m01')
})

test('dry refuses a queued --suite or no checkout, logs nothing', () => {
  const { dir, d } = rescorable('queued')
  expect(() => dried(d, dir, 1, dir, 1)).toThrow('plan 1 is not a done bench plan')
  expect(() => dried(d, dir, 1, dir)).toThrow('plan 1 has no checkout')
  expect(ofKind(d, 'bench.dry')).toEqual([])
})

test('rescore D3 --by takes ceo or coo only', () => {
  expect(() => holderOf('director')).toThrow('--by takes ceo or coo, not director')
})

/** `rescorable` with a medusa.json in the scored suite. */
function refuzzable(state: PlanRow['state'] = 'done'): { dir: string; d: Db } {
  const made = rescorable(state)
  writeFileSync(join(planDir(made.dir, 1), SCORED, 'medusa.json'), '{}')
  return made
}

const tree = (dir: string): string[] => readdirSync(planDir(dir, 1), { recursive: true, encoding: 'utf8' }).sort()

test('refuzz D1 files a step-2 plan on the source suite', () => {
  const { dir, d } = refuzzable()
  const before = { plan: planById(d, 1), tree: tree(dir), yml: get(dir, 1, 'target.yml'), made: get(dir, 1, 'generate.json') }
  const id = refuzz(d, dir, 1, 4, 2, 'ceo', 'weak or short?', AT)
  expect(planById(d, id)).toMatchObject({ template: 'bench', state: 'queued', step: 2, pipe_id: pipeNamed(d, 'refuzz')?.id })
  expect(planTitle(d, id)).toBe('Bench: refuzz plan 1 (fizz on euler-earn-m01), 4 h × 2 seeds')
  expect(get(dir, id, 'target.yml')).toBe(`${YML}target: euler-earn-m01\ngenerator: fizz\nmode: refuzz\nrefuzz: 1\nhours: 4\nseeds: 2\n`)
  expect(JSON.parse(get(dir, id, 'generate.json'))).toEqual({ suite: 'test/fizz', tokens: 0, seconds: 0 })
  expect(readFileSync(join(srcDir(dir, id), 'test/fizz/medusa.json'), 'utf8')).toBe('{}')
  expect(ofKind(d, 'refuzz')).toEqual([{ plan: id, kind: 'refuzz', actor: 'ceo', outcome: 'pass', message: 'weak or short?' }])
  expect({ plan: planById(d, 1), tree: tree(dir), yml: get(dir, 1, 'target.yml'), made: get(dir, 1, 'generate.json') }).toEqual(before)
  expect(() => record(d, ROW)).toThrow(/UNIQUE/)
})

function unfiled(dir: string, d: Db, why: string, hours = 4, seeds = 2): void {
  expect(() => refuzz(d, dir, 1, hours, seeds, 'ceo', 'why', AT)).toThrow(why)
  expect(allPlans(d)).toHaveLength(1)
  expect(ofKind(d, 'refuzz')).toEqual([])
}

test('refuzz D2 a plan not done is refused, nothing filed', () => {
  const { dir, d } = refuzzable('running')
  unfiled(dir, d, 'plan 1 is not a done bench plan')
})

test('refuzz D2 a walled generate is refused, nothing filed', () => {
  const { dir, d } = refuzzable()
  put(dir, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1, seconds: 1, wall: 'the token wall' }))
  unfiled(dir, d, 'plan 1 stopped at a wall: the token wall')
  put(dir, 1, 'generate.json', JSON.stringify({ suite: 'test/fizz', tokens: 1, seconds: 1, partial: 'the cost wall' }))
  unfiled(dir, d, 'plan 1 stopped at a wall: the cost wall')
})

test('refuzz D2 no suites or no medusa.json is refused', () => {
  const { dir, d } = refuzzable()
  rmSync(join(planDir(dir, 1), SCORED, 'medusa.json'))
  unfiled(dir, d, 'plan 1 has no medusa.json in fuzz-bench/suites/fizz/euler-earn-m01')
  rmSync(join(planDir(dir, 1), SCORED), { recursive: true })
  unfiled(dir, d, 'plan 1 has no fuzz-bench/suites/fizz/euler-earn-m01')
})

test('refuzz D2 --hours 0 and --seeds 1.5 are refused', () => {
  const { dir, d } = refuzzable()
  unfiled(dir, d, '--hours takes a positive whole number, not 0', 0)
  unfiled(dir, d, '--seeds takes a positive whole number, not 1.5', 4, 1.5)
})

test('refuzz D3 the plan waits for 22:00 Guatemala time', () => {
  const { dir, d } = refuzzable()
  dial(d, 3, AT)
  const id = refuzz(d, dir, 1, 4, 2, 'ceo', 'weak or short?', AT)
  const would = { pipe: 'refuzz', plan: id, step: 2, template: 'bench' }
  expect(dry(d, new Date('2026-09-18T16:00:00.000Z')).would).not.toContainEqual(would)
  expect(dry(d, new Date('2026-09-19T04:00:00.000Z')).would).toContainEqual(would)
})

test('cf bench medusa refuses bad workers or no medusa.json', () => {
  const src = root()
  const out = join(src, 'out.json')
  const d = fresh(schema)
  for (const [workers, why] of [[0, 'not 0'], [2.5, 'not 2.5'], [Number('four'), 'not NaN']] as const) {
    expect(() => medusaFile(d, src, 'test/fizz', workers, out)).toThrow(`--workers takes a positive whole number, ${why}`)
  }
  expect(() => medusaFile(d, src, 'test/fizz', 2, out)).toThrow(`no medusa.json in ${src} or ${join(src, 'test/fizz')}`)
  writeFileSync(join(src, 'medusa.json'), '{')
  expect(() => medusaFile(d, src, 'test/fizz', 2, out)).toThrow('JSON')
  expect(ofKind(d, 'swallowed')).toMatchObject([{ plan: null, kind: 'swallowed', actor: 'score' }])
  expect(existsSync(out)).toBe(false)
})

afterEach(() => { vi.unstubAllEnvs() })

/** A checkout with src/V.sol, lib/x.sol and test/fizz/medusa.json, and a forge on PATH that logs its args and runs `script`. */
function forged(script: string): string {
  const [src, bin] = [root(), root()]
  writeFileSync(join(bin, 'forge'), `#!/bin/sh\necho "$@" >> forge.log\n${script}\n`, { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
  for (const file of ['src/V.sol', 'lib/x.sol', 'test/fizz/medusa.json']) {
    mkdirSync(dirname(join(src, file)), { recursive: true })
    writeFileSync(join(src, file), '{}')
  }
  return src
}

test('cf bench medusa builds src and the suite once per change', () => {
  const src = forged('mkdir -p out/build-info')
  const d = fresh(schema)
  const builds = (): string[] => readFileSync(join(src, 'forge.log'), 'utf8').trimEnd().split('\n')
  const [one, two] = [join(src, 'one.json'), join(src, 'two.json')]
  for (const out of [one, two]) medusaFile(d, src, 'test/fizz', 2, out)
  expect(builds()).toEqual(['build --build-info --force src test/fizz'])
  for (const out of [one, two]) expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ compilation: { platformConfig: { args: ['--foundry-ignore-compile'] } } })
  writeFileSync(join(src, 'lib/x.sol'), 'contract X {}')
  expect(medusaFile(d, src, 'test/fizz', 2, one)).toEqual({ clamped: [], compile: 0 })
  expect(builds()).toHaveLength(1)
  writeFileSync(join(src, 'src/V.sol'), 'contract V {}')
  medusaFile(d, src, 'test/fizz', 2, one)
  expect(builds()).toHaveLength(2)
})

test('cf bench medusa throws on a failed forge, writes nothing', () => {
  const src = forged('exit 1')
  const out = join(src, 'out.json')
  expect(() => medusaFile(fresh(schema), src, 'test/fizz', 2, out)).toThrow('forge build --build-info --force src test/fizz exited 1')
  expect(existsSync(out)).toBe(false)
  expect(existsSync(join(src, 'cache/fizz-medusa-build.json'))).toBe(false)
})

const RUN = { step: 1, seat: 'fizz_generator', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
  input_tokens: 1, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 1, seconds: 1, exit: 0,
  at: AT, transcript_path: 'x.transcript.jsonl', cost_usd: null }

function creditable(template: PlanRow['template'] = 'bench'): { d: Db; ours: number[]; theirs: number } {
  const d = fresh(schema)
  upsertRule(d, { id: RUN.seat, kind: 'card', path: 'seats/seat.md', content_hash: RUN.rule_hash, loaded_at: AT })
  for (const id of [1, 2]) {
    putPlan(d, { id, pipe_id: Number(pipeNamed(d, 'bench')?.id), target_id: null, template: id === 1 ? template : 'bench', state: 'done', queued_at: AT, step: 4, retries: 0 })
  }
  for (const plan of [1, 1, 1, 2]) addRun(d, { ...RUN, plan })
  return { d, ours: runTokens(d, 1).map(({ id }) => id), theirs: Number(runTokens(d, 2)[0]?.id) }
}

const credits = (d: Db): ReturnType<typeof eventsAfter> => eventsAfter(d, 0).filter(({ kind }) => kind === 'bench.credit')

test('credit logs one bench.credit per run, coo, the why', () => {
  const { d, ours } = creditable()
  const before = planById(d, 1)
  credit(d, 1, [ours[2], ours[0], ours[1]].map(Number), 'reach misread')
  expect(credits(d)).toEqual([2, 0, 1].map((i) =>
    ({ plan: 1, kind: 'bench.credit', actor: 'coo', outcome: 'pass', message: 'reach misread', pointer: null, run: ours[i] })))
  expect(planById(d, 1)).toEqual(before)
})

test('credit refuses a foreign or unknown run, logs none', () => {
  const { d, ours, theirs } = creditable()
  expect(() => { credit(d, 1, [...ours, theirs], 'why') }).toThrow(`run ${String(theirs)} is not a run of plan 1`)
  expect(() => { credit(d, 1, [Number(ours[0]), 999], 'why') }).toThrow('run 999 is not a run of plan 1')
  expect(credits(d)).toEqual([])
})

test('spend nets out credited runs, each listed once', () => {
  const { d } = creditable()
  for (const [plan, cost_usd] of [[1, 1], [1, 2], [1, 4], [2, 8]] as const) addRun(d, { ...RUN, plan, cost_usd })
  const [two, four] = runTokens(d, 1).slice(-2).map(({ id }) => id)
  for (let i = 0; i < 2; i++) logged(d, { plan: 1, kind: 'bench.credit', actor: 'machine', outcome: 'pass', message: 'refire', pointer: null, run: Number(four) })
  credit(d, 1, [Number(two)], 'reach misread')
  expect(spend(d, 1)).toEqual({ gross: 7, net: 1, credited: [two, four] })
  expect(spend(d, 3)).toEqual({ gross: 0, net: 0, credited: [] })
})

test('credit refuses a non-bench plan and logs nothing', () => {
  const { d, ours } = creditable('research')
  expect(() => { credit(d, 1, ours, 'why') }).toThrow('plan 1 is not a bench plan')
  expect(credits(d)).toEqual([])
})

test('file D4 a seat that generates no bench is refused', () => {
  const d = fresh(schema)
  expect(() => fileBench(d, benchRoot(), 'euler-earn-m01', false, 'solidity_specialist', AT))
    .toThrow('solidity_specialist is not a bench generator in rules/staffing.yaml')
  expect(allPlans(d)).toEqual([])
})
