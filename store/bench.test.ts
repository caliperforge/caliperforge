import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { record, scores, type Score } from './bench.ts'
import { migrate, open, type Db } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function db(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  return db
}

const fizz = { target: 'euler-earn-m01', generator: 'fizz', catches: 3, false_positives: 1, untested: 2, tokens: 4200, seconds: 61.5 }

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
  for (const bad of [{ catches: -1 }, { false_positives: -1 }, { untested: -1 }, { tokens: -1 }, { seconds: -0.5 }, { target: '' }, { generator: '' }]) {
    expect(() => record(d, { plan, ...fizz, ...bad })).toThrow(/CHECK/)
  }
})

it('D4 migrates once to 104 with one bench_scorecard table', () => {
  const d = open(':memory:')
  expect(migrate(d, join(root, 'schema')).at(-1)).toBe('0104_site_lane.sql')
  expect(migrate(d, join(root, 'schema'))).toEqual([])
  expect(d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bench_scorecard'").get()).toEqual({ n: 1 })
  expect(d.pragma('user_version', { simple: true })).toBe(104)
})
