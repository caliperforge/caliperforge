import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { record, scores } from './bench.ts'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D4 0112 keeps an 0111 row and admits untested NULL', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0111-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0112')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  const plan = planRow(db)
  record(db, { plan, target: 'a', generator: 'fizz', catches: 1, false_positives: 0, untested: 0, tokens: 10, seconds: 1.5, x_ray: 1 })
  const before = db.prepare('SELECT * FROM bench_scorecard').all()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql'])
  expect(db.prepare('SELECT * FROM bench_scorecard').all()).toEqual(before.map((row) => ({ ...(row as object), superseded: 0 })))
  const next = { plan: planRow(db), target: 'b', generator: 'fizz', catches: 0, false_positives: 0, untested: null, tokens: 0, seconds: 0, x_ray: null }
  record(db, next)
  expect(scores(db).at(-1)).toEqual(next)
  for (const bad of [{ untested: -1 }, { x_ray: 2 as 1 }]) {
    expect(() => record(db, { ...next, plan: planRow(db), ...bad })).toThrow(/CHECK/)
  }
  expect(() => record(db, next)).toThrow(/UNIQUE/)
})
