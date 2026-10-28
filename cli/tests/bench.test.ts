import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../../checks/sqlite.ts'
import { homeOf } from '../../sequencer/home.ts'
import { dry } from '../../sequencer/index.ts'
import { get, git, planDir, put, srcDir } from '../../sequencer/workspace.ts'
import { record } from '../../store/bench.ts'
import { ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { dial, lanes } from '../../store/lanes.ts'
import { allPlans, holderOf, openPipes, pipeNamed, planById, planTitle, putPlan, type PlanRow } from '../../store/plans.ts'
import { fileBench, refuzz, rescore } from '../bench.ts'
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

const SCORED = 'fuzz-bench/suites/fizz/euler-earn-m01'

const ROW = { plan: 1, target: 'euler-earn-m01', generator: 'fizz', catches: 0, false_positives: 0, untested: null, tokens: 1, seconds: 1, x_ray: null,
  pre_fix_calls: null, fix_calls: null, not_powered: null }

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
  expect(get(dir, id, 'target.yml')).toBe(`${YML}target: euler-earn-m01\ngenerator: fizz\nrefuzz: 1\nhours: 4\nseeds: 2\n`)
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

test('file D4 a seat that generates no bench is refused', () => {
  const d = fresh(schema)
  expect(() => fileBench(d, benchRoot(), 'euler-earn-m01', false, 'solidity_specialist', AT))
    .toThrow('solidity_specialist is not a bench generator in rules/staffing.yaml')
  expect(allPlans(d)).toEqual([])
})
