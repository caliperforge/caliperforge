import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { addPlan } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D5 0106 marks staffed review runs review, leaves the rest', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0105-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0106')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  for (const seat of ['code_quality', 'senior_review', 'typescript_specialist']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'rules/seats.yaml', ?, '2026-10-16')").run(seat, 'a'.repeat(64))
  }
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-16T00:00:00.000Z',
    lane: 'machine', seat: 'python_specialist', origin: 'https://github.com/caliperforge/fuzz-bench/issues/12', step: 0 })
  const run = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens,
    output_tokens, seconds, exit, transcript_path, mode, staffed)
    VALUES (?, ?, ?, ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, 'x.transcript.jsonl', ?, ?)`)
  for (const [step, seat, mode, staffed] of [
    [4, 'code_quality', null, 'python_specialist'],
    [5, 'senior_review', null, 'python_specialist'],
    [4, 'code_quality', null, null],
    [5, 'senior_review', 'fix', 'typescript_specialist'],
    [4, 'typescript_specialist', null, 'typescript_specialist'],
  ]) run.run(plan, step, seat, '0'.repeat(64), mode, staffed)
  const before = db.prepare('SELECT * FROM runs ORDER BY id').all() as Record<string, unknown>[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0106_review_mode_backfill.sql', '0107_loupe_lane.sql', '0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql'])
  expect(db.prepare('SELECT * FROM runs ORDER BY id').all()).toEqual(before.map((r, i) => (i < 2 ? { ...r, mode: 'review' } : r)))
})
