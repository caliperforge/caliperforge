import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { dump, migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('applies every migration once and records the version', () => {
  const db = open(':memory:')
  expect(migrate(db, join(root, 'schema'))).toEqual(['0001_init.sql', '0002_rulings.sql', '0003_runs_rule_hash.sql', '0004_one_disposition_per_verdict.sql', '0005_tick.sql', '0006_runs_transcript_path.sql', '0007_batch.sql', '0008_head_digest.sql', '0009_open_loop.sql', '0010_lanes.sql', '0011_issue_plans.sql', '0012_feeder.sql', '0013_internal_plans.sql', '0014_adopted_pr.sql', '0015_brief_read.sql', '0017_plan_files.sql', '0018_refusals.sql', '0019_signal_words.sql', '0020_leases.sql', '0021_parts.sql', '0022_band_p95.sql', '0023_reading_holds_ceiling.sql', '0024_run_token_wall.sql', '0025_wait_reason.sql', '0026_decisions.sql', '0027_verdict_tree.sql', '0028_priority_label.sql', '0029_merges.sql', '0030_kept_verdicts.sql', '0031_file_overlap.sql', '0032_stray_files.sql', '0033_quick_lane.sql', '0034_target_part.sql', '0035_caps_skip_cache_reads.sql', '0036_decisions_blocked_on_ceo.sql', '0037_decisions_applied.sql', '0039_events.sql', '0040_hq_path.sql', '0041_signal_head.sql', '0042_now.sql', '0043_reviewer_not_builder_skips_fixer.sql', '0044_tickets.sql', '0045_records.sql', '0046_brief_lines.sql', '0047_runs_cost.sql', '0048_scan_evidence.sql'])
  expect(db.pragma('user_version', { simple: true })).toBe(48)
  expect(migrate(db, join(root, 'schema'))).toEqual([])
})

it('dumps a database that replays into an identical one', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare("INSERT INTO rules VALUES ('r', 'rail', 'rules/rails.yaml', ?, '2026-09-16')").run('a'.repeat(64))
  const out = join(mkdtempSync(join(tmpdir(), 'cf-')), 'dump.sql')
  dump(db, out)
  const replay = open(':memory:')
  replay.exec(readFileSync(out, 'utf8'))
  expect(replay.prepare('SELECT id FROM rules').all()).toEqual([{ id: 'r' }])
})

it('a schema file that fails leaves the version and the half-written table behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-schema-'))
  writeFileSync(join(dir, '0001_kept.sql'), 'CREATE TABLE kept (id INTEGER PRIMARY KEY);\n')
  writeFileSync(join(dir, '0002_half.sql'),
    'CREATE TABLE half (id INTEGER PRIMARY KEY);\nINSERT INTO half (id) VALUES (1), (1);\n')
  const db = open(':memory:')

  expect(() => migrate(db, dir)).toThrow(/UNIQUE|PRIMARY KEY/)
  expect(db.pragma('user_version', { simple: true })).toBe(1)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('kept', 'half')").all()).toEqual([{ name: 'kept' }])
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
})
