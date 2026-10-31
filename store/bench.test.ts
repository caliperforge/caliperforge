import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { record, scores, setUntested, supersede, underpowered, type Score } from './bench.ts'
import { migrate, open, type Db } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function db(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  return db
}

const fizz = { target: 'euler-earn-m01', generator: 'fizz', catches: 3, false_positives: 1, untested: 2, tokens: 4200, seconds: 61.5, x_ray: 1 as const,
  pre_fix_calls: 505660, fix_calls: 505660, not_powered: null }

/** A database migrated through every schema file before `version`. */
function before(version: string): Db {
  const old = mkdtempSync(join(tmpdir(), `cf-${version}-`))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < version)) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const d = open(':memory:')
  migrate(d, old)
  return d
}

it('D1 record for fizz reads back as the one row', () => {
  const d = db()
  const score: Score = { plan: planRow(d), ...fizz }
  record(d, score)
  expect(scores(d)).toEqual([score])
})

it('D2 refuses a second row per plan and an unknown plan', () => {
  const d = db()
  const plan = planRow(d)
  record(d, { plan, ...fizz })
  expect(() => record(d, { plan, ...fizz })).toThrow(/UNIQUE/)
  expect(() => record(d, { plan: plan + 1, ...fizz })).toThrow(/FOREIGN KEY/)
})

it('D3 refuses negative counts and empty names', () => {
  const d = db()
  const plan = planRow(d)
  for (const bad of [{ catches: -1 }, { false_positives: -1 }, { untested: -1 }, { tokens: -1 }, { seconds: -0.5 }, { target: '' }, { generator: '' },
    { x_ray: 2 as 1 }]) {
    expect(() => record(d, { plan, ...fizz, ...bad })).toThrow(/CHECK/)
  }
})

it('setUntested sets the one plan row', () => {
  const d = db()
  const [one, two] = [planRow(d), planRow(d)]
  record(d, { plan: one, ...fizz, untested: null })
  record(d, { plan: two, ...fizz, untested: null })
  setUntested(d, one, 4)
  expect(scores(d).map((s) => s.untested)).toEqual([4, null])
})

it('D1 D4 migrates once to 126 with one bench_scorecard table', () => {
  const d = open(':memory:')
  expect(migrate(d, join(root, 'schema')).at(-1)).toBe('0126_outcomes_cancelled.sql')
  expect(migrate(d, join(root, 'schema'))).toEqual([])
  expect(d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bench_scorecard'").get()).toEqual({ n: 1 })
  expect(d.pragma('user_version', { simple: true })).toBe(126)
})

it('1645b D4 accepts compile_failed, refuses short', () => {
  const d = db()
  const score: Score = { plan: planRow(d), ...fizz, not_powered: 'compile_failed' }
  record(d, score)
  expect(scores(d)).toEqual([score])
  expect(() => record(d, { plan: planRow(d), ...fizz, not_powered: 'short' as 'wall' })).toThrow(/CHECK/)
})

it('1645b D5 0120 keeps every 0119 row, live or superseded', () => {
  const d = before('0120')
  const [one, two] = [planRow(d), planRow(d)]
  const reasons = [null, 'wall', 'reduced_generate', 'few_properties', 'pre_fix_calls', 'fix_calls']
  const old: Score[] = reasons.map((why) => ({ plan: one, ...fizz, not_powered: why as Score['not_powered'] }))
  for (const score of old) {
    record(d, score)
    supersede(d, one)
  }
  const live: Score = { plan: two, ...fizz, not_powered: 'few_properties' }
  record(d, live)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_outcomes_cancelled.sql'])
  expect(scores(d)).toEqual([...old, live])
  expect(underpowered(d)).toEqual([live])
  expect(() => record(d, { plan: two, ...fizz })).toThrow(/UNIQUE/)
  expect(supersede(d, two)).toBe(old.length + 1)
})

it('D5 accepts the five reasons, refuses short', () => {
  const d = db()
  for (const why of ['wall', 'reduced_generate', 'few_properties', 'pre_fix_calls', 'fix_calls'] as const) record(d, { plan: planRow(d), ...fizz, not_powered: why })
  expect(scores(d).map((s) => s.not_powered)).toEqual(['wall', 'reduced_generate', 'few_properties', 'pre_fix_calls', 'fix_calls'])
  expect(() => record(d, { plan: planRow(d), ...fizz, not_powered: 'short' as 'wall' })).toThrow(/CHECK/)
})

it('D5 0119 keeps every 0118 row, live or superseded', () => {
  const d = before('0119')
  const [one, two] = [planRow(d), planRow(d)]
  const old: Score[] = [null, 'wall', 'reduced_generate', 'pre_fix_calls', 'fix_calls'].map((why) => ({ plan: one, ...fizz, not_powered: why as Score['not_powered'] }))
  for (const score of old) {
    record(d, score)
    supersede(d, one)
  }
  const live: Score = { plan: two, ...fizz, not_powered: 'fix_calls' }
  record(d, live)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_outcomes_cancelled.sql'])
  expect(scores(d)).toEqual([...old, live])
  expect(underpowered(d)).toEqual([live])
  expect(() => record(d, { plan: two, ...fizz })).toThrow(/UNIQUE/)
  expect(supersede(d, two)).toBe(old.length + 1)
})

it('D2 0118 reads an 0117 row by its calls a side', () => {
  const d = before('0118')
  const insert = d.prepare(`INSERT INTO bench_scorecard (plan, target, generator, catches, false_positives, untested, tokens, seconds, x_ray,
    pre_fix_calls, fix_calls) VALUES (?, 'a', 'fizz', 1, 0, 0, 10, 1.5, 1, ?, ?)`)
  for (const [pre, fix] of [[69467, 69467], [505660, 505660], [505660, 1000]]) insert.run(planRow(d), pre, fix)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_outcomes_cancelled.sql'])
  expect(scores(d).map((s) => s.not_powered)).toEqual(['pre_fix_calls', null, 'fix_calls'])
})

it('D1 0117 reads an 0116 row as NULL calls, refuses -1', () => {
  const d = before('0117')
  const plan = planRow(d)
  d.prepare(`INSERT INTO bench_scorecard (plan, target, generator, catches, false_positives, untested, tokens, seconds, x_ray)
    VALUES (?, 'a', 'fizz', 1, 0, 0, 10, 1.5, 1)`).run(plan)
  expect(migrate(d, join(root, 'schema'))).toEqual(['0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql',
    '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_outcomes_cancelled.sql'])
  expect(scores(d)).toMatchObject([{ plan, pre_fix_calls: null, fix_calls: null }])
  for (const bad of [{ pre_fix_calls: -1 }, { fix_calls: -1 }]) {
    expect(() => record(d, { plan: planRow(d), ...fizz, ...bad })).toThrow(/CHECK/)
  }
})

it('D2 calls of 69467 a side read back through scores', () => {
  const d = db()
  const score: Score = { plan: planRow(d), ...fizz, pre_fix_calls: 69467, fix_calls: 69467 }
  record(d, score)
  expect(scores(d)).toEqual([score])
})

it('D6 underpowered lists live rows with a reason only', () => {
  const d = db()
  const [low, high, walled, old] = [planRow(d), planRow(d), planRow(d), planRow(d)]
  record(d, { plan: low, ...fizz, pre_fix_calls: 69467, fix_calls: 69467, not_powered: 'pre_fix_calls' })
  record(d, { plan: high, ...fizz })
  record(d, { plan: walled, ...fizz, pre_fix_calls: null, fix_calls: null, not_powered: 'wall' })
  record(d, { plan: old, ...fizz, fix_calls: 1000, not_powered: 'fix_calls' })
  supersede(d, old)
  expect(underpowered(d).map((s) => [s.plan, s.not_powered])).toEqual([[low, 'pre_fix_calls'], [walled, 'wall']])
})

it('D4 a live row beside a superseded one is kept', () => {
  const d = db()
  const plan = planRow(d)
  expect(supersede(d, plan)).toBeNull()
  const old = record(d, { plan, ...fizz })
  expect(supersede(d, plan)).toBe(old)
  record(d, { plan, ...fizz, catches: 5 })
  expect(scores(d).map((s) => s.catches)).toEqual([3, 5])
  expect(() => record(d, { plan, ...fizz })).toThrow(/UNIQUE/)
  expect(() => d.prepare('UPDATE bench_scorecard SET superseded = 2').run()).toThrow(/CHECK/)
})
