import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planRow } from '../runner/index.ts'
import { record, scores } from './bench.ts'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 0110 reads an 0109 row as NULL and refuses x_ray 2', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0109-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0110')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  const plan = planRow(db)
  db.prepare(`INSERT INTO bench_scorecard (plan, target, generator, catches, false_positives, untested, tokens, seconds)
    VALUES (?, 'a', 'fizz', 1, 0, 0, 10, 1.5)`).run(plan)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql'])
  expect(scores(db)).toEqual([{ plan, target: 'a', generator: 'fizz', catches: 1, false_positives: 0, untested: 0, tokens: 10, seconds: 1.5, x_ray: null,
    pre_fix_calls: null, fix_calls: null, not_powered: 'pre_fix_calls' }])
  expect(() => record(db, { plan: planRow(db), target: 'a', generator: 'fizz', catches: 0, false_positives: 0, untested: 0, tokens: 0, seconds: 0,
    x_ray: 2 as 1, pre_fix_calls: null, fix_calls: null, not_powered: null })).toThrow(/CHECK/)
})
