import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open, type Db } from './index.ts'
import { PlanRow } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function at0108(names: string[]): Db {
  const old = mkdtempSync(join(tmpdir(), 'cf-0108-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0109')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  for (const name of names) {
    db.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES (?, 1, '00:00', '23:59', 1)").run(name)
  }
  return db
}

const id = (db: Db, name: string): number => (db.prepare('SELECT id FROM pipes WHERE name = ?').get(name) as { id: number }).id
const all = (db: Db): Record<string, unknown>[] => db.prepare('SELECT * FROM plans ORDER BY id').all() as Record<string, unknown>[]
const web = (n: number): string => `https://github.com/caliperforge/atelier-web/issues/${String(n)}`

const plan = (db: Db, pipe: string, lane: string, origin: string): void => {
  db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, priority, lane, seat, origin, title)
    VALUES (?, 'pr_path', 'queued', '2026-10-16', 1, ?, 'web_specialist', ?, 't')`).run(id(db, pipe), lane, origin)
}

it('D2 D4 0109 refuses lane atelier and admits loupe', () => {
  const db = at0108(['loupe'])
  migrate(db, join(root, 'schema'))
  plan(db, 'loupe', 'loupe', web(1))
  expect(() => { plan(db, 'loupe', 'atelier', web(2)) }).toThrow(/CHECK constraint/)
  const row = PlanRow.parse(all(db)[0])
  expect(row.lane).toBe('loupe')
  expect(() => PlanRow.parse({ ...row, lane: 'atelier' })).toThrow()
  expect(() => { plan(db, 'loupe', 'lupe', web(3)) }).toThrow(/CHECK constraint/)
})

it('D3 0109 keeps every plans row and moves atelier onto loupe', () => {
  const db = at0108(['loupe', 'atelier'])
  plan(db, 'loupe', 'loupe', web(1))
  plan(db, 'atelier', 'atelier', web(2))
  const before = all(db)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_runs_mode_handback.sql'])
  expect(all(db)).toEqual([before[0], { ...before[1], pipe_id: id(db, 'loupe'), lane: 'loupe' }])
  expect(db.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'plans' AND type IN ('index', 'trigger') ORDER BY name").all())
    .toEqual([
      { type: 'trigger', name: 'plans_held_on_entry' },
      { type: 'trigger', name: 'plans_held_on_exit' },
      { type: 'trigger', name: 'plans_leave_batch_on_approval' },
      { type: 'index', name: 'plans_one_comms' },
      { type: 'index', name: 'plans_one_per_issue' },
    ])
})
