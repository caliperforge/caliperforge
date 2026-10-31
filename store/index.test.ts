import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { LOCKED, addRule, dump, lapping, migrate, open, rules, upsertRule } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
const stderr = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

afterEach(() => { vi.restoreAllMocks() })

it('applies every migration once and records the version', () => {
  const db = open(':memory:')
  expect(migrate(db, join(root, 'schema'))).toEqual(['0001_init.sql', '0002_rulings.sql', '0003_runs_rule_hash.sql', '0004_one_disposition_per_verdict.sql', '0005_tick.sql', '0006_runs_transcript_path.sql', '0007_batch.sql', '0008_head_digest.sql', '0009_open_loop.sql', '0010_lanes.sql', '0011_issue_plans.sql', '0012_feeder.sql', '0013_internal_plans.sql', '0014_adopted_pr.sql', '0015_brief_read.sql', '0017_plan_files.sql', '0018_refusals.sql', '0019_signal_words.sql', '0020_leases.sql', '0021_parts.sql', '0022_band_p95.sql', '0023_reading_holds_ceiling.sql', '0024_run_token_wall.sql', '0025_wait_reason.sql', '0026_decisions.sql', '0027_verdict_tree.sql', '0028_priority_label.sql', '0029_merges.sql', '0030_kept_verdicts.sql', '0031_file_overlap.sql', '0032_stray_files.sql', '0033_quick_lane.sql', '0034_target_part.sql', '0035_caps_skip_cache_reads.sql', '0036_decisions_blocked_on_ceo.sql', '0037_decisions_applied.sql', '0039_events.sql', '0040_hq_path.sql', '0041_signal_head.sql', '0042_now.sql', '0043_reviewer_not_builder_skips_fixer.sql', '0044_tickets.sql', '0045_records.sql', '0046_brief_lines.sql', '0047_runs_cost.sql', '0048_scan_evidence.sql', '0049_part_after.sql', '0050_target_take.sql', '0051_held_by.sql', '0052_ratchet_counts.sql', '0053_tick_lanes.sql', '0054_gardens.sql', '0055_ticket_times.sql', '0056_size_limits.sql', '0057_refusal_ticket.sql', '0058_comms_once.sql', '0059_reviewer_not_builder_skips_coo_lite.sql', '0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql', '0066_parked_why.sql', '0067_outcomes.sql', '0068_band_open_0928.sql', '0069_events_plan_nullable.sql', '0070_ticket_outcomes.sql', '0071_desk_proof_at.sql', '0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql', '0097_unreached.sql', '0098_runs_mode_catchup.sql', '0099_ticket_wave.sql', '0100_desk_release.sql', '0101_bench_lane.sql', '0102_bench_scorecard.sql', '0103_bench_template.sql', '0104_site_lane.sql', '0105_account_template.sql', '0106_review_mode_backfill.sql', '0107_loupe_lane.sql', '0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_outcomes_cancelled.sql'])
  expect(db.pragma('user_version', { simple: true })).toBe(126)
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

it('D1 D3 a new file opens in WAL mode with a 10s busy timeout', () => {
  const db = open(join(mkdtempSync(join(tmpdir(), 'cf-wal-')), 'cf.db'))
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  expect(db.pragma('busy_timeout', { simple: true })).toBe(10000)
})

it('D2 D4 a write commits while another connection holds a read', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-wal-')), 'cf.db')
  const writer = open(path)
  migrate(writer, join(root, 'schema'))
  const reader = open(path)
  reader.exec('BEGIN')
  expect(reader.prepare('SELECT count(*) AS n FROM rules').get()).toEqual({ n: 0 })
  addRule(writer, { id: 'r', kind: 'rail', path: 'rules/rails.yaml', content_hash: 'a'.repeat(64), loaded_at: '2026-09-28' })
  expect(rules(writer).map((r) => r.id)).toEqual(['r'])
  reader.exec('COMMIT')
})

it('D2 upsertRule replaces the row an id already holds', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  upsertRule(db, { id: 'r', kind: 'card', path: 'reviews/r/spec.md', content_hash: 'a'.repeat(64), loaded_at: '2026-10-01' })
  upsertRule(db, { id: 'r', kind: 'card', path: 'reviews/r/spec.md', content_hash: 'b'.repeat(64), loaded_at: '2026-10-02' })
  expect(rules(db).map((r) => [r.id, r.content_hash, r.loaded_at])).toEqual([['r', 'b'.repeat(64), '2026-10-02']])
})

it('a failed schema leaves the version and a half-written table', () => {
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

it('D1 a transaction held past 1 s logs its caller and plan', () => {
  const write = stderr()
  const db = open(':memory:')
  lapping.run(7, () => { db.transaction(() => { sleep(1100) })() })
  expect(write.mock.calls).toEqual([[expect.stringMatching(/^cf: transaction held 1\.\d s at store\/index\.test\.ts:74 plan 7\n$/)]])
})

it('D2 a transaction under 1 s logs nothing', () => {
  const write = stderr()
  const db = open(':memory:')
  expect(lapping.run(7, () => db.transaction(() => 3)())).toBe(3)
  expect(write).not.toHaveBeenCalled()
})

it('D3 a slow transaction outside a lap logs plan none', () => {
  const write = stderr()
  const db = open(':memory:')
  db.transaction(() => { sleep(1100) })()
  expect(write.mock.calls).toEqual([[expect.stringMatching(/^cf: transaction held 1\.\d s at store\/index\.test\.ts:88 plan none\n$/)]])
})

const locked = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cf-busy-')), 'cf.db')
  const db = open(path)
  db.pragma('busy_timeout = 50')
  db.exec('CREATE TABLE t (n INTEGER)')
  const holder = open(path)
  holder.exec('BEGIN IMMEDIATE')
  return { db, holder }
}

it('D1 D2 a busy BEGIN retries and commits once the lock goes', () => {
  const { db, holder } = locked()
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { holder.exec('COMMIT'); return true })
  expect(db.transaction(() => db.prepare('INSERT INTO t VALUES (1)').run().changes)()).toBe(1)
  expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 1 }])
  expect(write.mock.calls).toEqual([[expect.stringMatching(/^cf: store busy at store\/index\.test\.ts:105 plan none, retry 1 in 100 ms\n$/)]])
  expect(String(write.mock.calls[0]?.[0])).not.toContain('database is locked')
})

it('D3 a lock never released throws after 4 retries', () => {
  const { db } = locked()
  const write = stderr()
  let runs = 0
  expect(() => { db.transaction(() => { runs++ })() }).toThrow(/database is locked/)
  expect(runs).toBe(0)
  expect(write).toHaveBeenCalledTimes(4)
})

it('D4 a LOCKED throw from the body is not retried', () => {
  const write = stderr()
  const db = open(':memory:')
  let runs = 0
  expect(() => db.transaction(() => { runs++; throw new Error(LOCKED) })()).toThrow(LOCKED)
  expect(runs).toBe(1)
  expect(write).not.toHaveBeenCalled()
})
