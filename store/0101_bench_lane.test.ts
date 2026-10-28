import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D6 0101 keeps plans rows, views, triggers and indexes', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0100-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0101')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, priority, lane, seat, origin, title, held_by, held_why, held_until)
    VALUES (1, 'pr_path', 'blocked_on_ceo', '2026-10-01', 3, 'uniswap', 'python_specialist',
      'https://github.com/caliperforge/v4-hook-index/issues/1', 't', 'ceo', 'why', '2026-10-20')`).run()
  const before = db.prepare('SELECT * FROM plans').all()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0101_bench_lane.sql', '0102_bench_scorecard.sql', '0103_bench_template.sql', '0104_site_lane.sql', '0105_account_template.sql', '0106_review_mode_backfill.sql', '0107_loupe_lane.sql', '0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql'])
  expect(db.prepare('SELECT * FROM plans').all()).toEqual(before)
  expect(() => db.prepare('SELECT * FROM outcomes').all()).not.toThrow()
  expect(() => db.prepare('SELECT * FROM queue_order').all()).not.toThrow()
  expect(db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'plans' AND type IN ('index', 'trigger') ORDER BY name").all())
    .toEqual([
      { type: 'trigger', name: 'plans_held_on_entry' },
      { type: 'trigger', name: 'plans_held_on_exit' },
      { type: 'trigger', name: 'plans_leave_batch_on_approval' },
      { type: 'index', name: 'plans_one_comms' },
      { type: 'index', name: 'plans_one_per_issue' },
    ])
})
