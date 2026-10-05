import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { walk } from '../checks/tree.ts'
import { addSetting, setting } from './drift.ts'
import { eventsOf } from './events.ts'
import { addRule, dump, migrate, open, rules } from './index.ts'
import { FORK, SELF } from '../sequencer/workspace.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { get, LANE, set, windows } from './lanes.ts'
import { setLimit } from './limits.ts'
import { addPart, allParts } from './parts.ts'
import { addPlan, briefed, builderRan, clearWaitsOn, end, holdOn, requeue, resume } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('applies every migration once and records the version', () => {
  const db = open(':memory:')
  expect(migrate(db, join(root, 'schema'))).toEqual(['0001_init.sql', '0002_rulings.sql', '0003_runs_rule_hash.sql', '0004_one_disposition_per_verdict.sql', '0005_tick.sql', '0006_runs_transcript_path.sql', '0007_batch.sql', '0008_head_digest.sql', '0009_open_loop.sql', '0010_lanes.sql', '0011_issue_plans.sql', '0012_feeder.sql', '0013_internal_plans.sql', '0014_adopted_pr.sql', '0015_brief_read.sql', '0017_plan_files.sql', '0018_refusals.sql', '0019_signal_words.sql', '0020_leases.sql', '0021_parts.sql', '0022_band_p95.sql', '0023_reading_holds_ceiling.sql', '0024_run_token_wall.sql', '0025_wait_reason.sql', '0026_decisions.sql', '0027_verdict_tree.sql', '0028_priority_label.sql', '0029_merges.sql', '0030_kept_verdicts.sql', '0031_file_overlap.sql', '0032_stray_files.sql', '0033_quick_lane.sql', '0034_target_part.sql', '0035_caps_skip_cache_reads.sql', '0036_decisions_blocked_on_ceo.sql', '0037_decisions_applied.sql', '0039_events.sql', '0040_hq_path.sql', '0041_signal_head.sql', '0042_now.sql', '0043_reviewer_not_builder_skips_fixer.sql', '0044_tickets.sql', '0045_records.sql', '0046_brief_lines.sql', '0047_runs_cost.sql', '0048_scan_evidence.sql', '0049_part_after.sql', '0050_target_take.sql', '0051_held_by.sql', '0052_ratchet_counts.sql', '0053_tick_lanes.sql', '0054_gardens.sql', '0055_ticket_times.sql', '0056_size_limits.sql', '0057_refusal_ticket.sql', '0058_comms_once.sql', '0059_reviewer_not_builder_skips_coo_lite.sql', '0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql', '0066_parked_why.sql', '0067_outcomes.sql', '0068_band_open_0928.sql', '0069_events_plan_nullable.sql', '0070_ticket_outcomes.sql', '0071_desk_proof_at.sql', '0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.pragma('user_version', { simple: true })).toBe(92)
  expect(migrate(db, join(root, 'schema'))).toEqual([])
})

it('D3 LANE literals match the constants they replaced', () => {
  expect(LANE.machine).toMatchObject({ seat: DEFAULT_BUILDER, home: SELF })
  expect(LANE.atelier.home).toBe(`${FORK}/atelier`)
  expect(LANE.uniswap.home).toBe(`${FORK}/v4-hook-index`)
})

it('D5 0078 adds drift.at; set refuses a key no migration added', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  set(db, 'drift.at', '2026-10-03', 'pr', '2026-10-03')
  expect(get(db, 'drift.at')).toBe('2026-10-03')
  expect(() => { set(db, 'drift.never', '2026-10-03', 'pr', '2026-10-03') }).toThrow(/no settings row/)
})

it('D1 0064 adds desk tables; only comms.site_dir holds a path', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(db.prepare('SELECT count(*) AS n FROM desk_posts, desk_learnings').get()).toEqual({ n: 0 })
  expect(get(db, 'comms.site_dir')).toBe('')
  set(db, 'comms.site_dir', '/tmp/site', 'ceo', '2026-09-28')
  expect(get(db, 'comms.site_dir')).toBe('/tmp/site')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-09-28') }).toThrow(/CHECK constraint failed/)
})

it('D1 D2 D3 0079 seeds comms.story_dir and lets it hold a path', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(get(db, 'comms.story_dir')).toBe('~/cf_comms/story')
  set(db, 'comms.story_dir', '/tmp/story', 'ceo', '2026-10-03')
  expect(get(db, 'comms.story_dir')).toBe('/tmp/story')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-10-03') }).toThrow(/CHECK constraint failed/)
})

it('D4 0079 keeps every settings row', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0078-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0079')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  const before = db.prepare('SELECT * FROM settings ORDER BY key').all()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare("SELECT * FROM settings WHERE key NOT IN ('comms.story_dir', 'ratchet.mode', 'science.dir', 'science.at') ORDER BY key").all())
    .toEqual(before)
  expect(get(db, 'comms.story_dir')).toBe('~/cf_comms/story')
})

it('D5 0081 seeds science.dir and lets it hold a path', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(get(db, 'science.dir')).toBe('~/Documents/Claude/Projects/HQ/science')
  set(db, 'science.dir', '/tmp/x', 'ceo', '2026-10-03')
  expect(get(db, 'science.dir')).toBe('/tmp/x')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-10-03') }).toThrow(/CHECK constraint failed/)
})

it('D5 0083 seeds science.at and set takes a date', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(get(db, 'science.at')).toBe('2026-01-01')
  set(db, 'science.at', '2026-10-04', 'pr', '2026-10-04')
  expect(get(db, 'science.at')).toBe('2026-10-04')
})

it('D1 0068 opens p80 and p95 to 8, leaves p30, p60 and p100', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(['p30', 'p60', 'p80', 'p95', 'p100'].map((p) => get(db, `lanes.band.${p}`))).toEqual(['3', '2', '8', '8', 'spot'])
})

it('D1 D5 0060-0062 keep totals and CHECK, split windows by type', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0059-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0060')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.pragma('foreign_keys = OFF')
  const seed = db.prepare(`INSERT INTO runs VALUES (NULL, ?, 2, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'm', 'high',
    ?, ?, ?, 1, 0, datetime('now', ?), 'x.transcript.jsonl', NULL)`)
  seed.run(1, 10, 200, 3, '-1 hour')
  seed.run(2, 20, 400, 5, '-2 day')
  const before = db.prepare('SELECT kind, runs, tokens FROM machine_window ORDER BY kind').raw().all()
  expect(before).toEqual([['five_hour', 1, 213], ['seven_day', 2, 638]])
  expect(() => windows(db)).toThrow()

  expect(migrate(db, join(root, 'schema'))).toEqual(['0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql', '0066_parked_why.sql', '0067_outcomes.sql', '0068_band_open_0928.sql', '0069_events_plan_nullable.sql', '0070_ticket_outcomes.sql', '0071_desk_proof_at.sql', '0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(windows(db).map((w) => [w.kind, w.runs, w.tokens])).toEqual(before)
  for (const w of windows(db)) expect(w.uncached_tokens + w.cache_write_tokens + w.cache_read_tokens + w.output_tokens).toBe(w.tokens)
  expect(db.prepare('SELECT sum(input_tokens + cache_read_tokens + output_tokens) AS n FROM runs').get()).toEqual({ n: 638 })
  expect(() => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens,
    output_tokens, seconds, exit, transcript_path) VALUES (3, 2, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'm', 'high',
    0, -1, 0, 1, 0, 'x.transcript.jsonl')`).run()).toThrow(/CHECK constraint failed: cache_read_tokens/)
})

it('D6 0071 sets each desk post proof_at to its written_date', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0070-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0071')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (1, 'daily', 'site', 'proof', 't', 'd', 'b', '[]', '[]', '2026-09-20', '2026-09-21')`).run()
  expect(migrate(db, join(root, 'schema'))).toEqual(['0071_desk_proof_at.sql', '0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT proof_at FROM desk_posts').get()).toEqual({ proof_at: '2026-09-21' })
})

it('D6 0072 keeps desk post columns, admits dest pack, not blog', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0071-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0072')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note,
    sources, checks, work_date, written_date, "order", proof_at)
    VALUES (1, 'daily', 'note', 'changes', 't', 'd', 'b', 'et', 'ed', 'eb', 'n', '["s"]', '["c"]', '2026-09-20', '2026-09-21', 3, '2026-09-22 10:00:00')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, url: null, published_at: null })))
  const insert = db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (?, 'growth', ?, 'proof', 't', '', 'b', '[]', '[]', '2026-09-28', '2026-09-28')`)
  insert.run(2, 'pack')
  expect(() => insert.run(3, 'blog')).toThrow(/CHECK constraint failed/)
})

it('D6 0073 keeps rows, admits scorecard and step 10, not blog', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0072-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0073')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note,
    sources, checks, work_date, written_date, "order", proof_at)
    VALUES (1, 'growth', 'pack', 'changes', 't', 'd', 'b', 'et', 'ed', 'eb', 'n', '["s"]', '["c"]', '2026-09-20', '2026-09-21', 3, '2026-09-22 10:00:00')`).run()
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, title)
    VALUES (1, (SELECT min(id) FROM pipes), 'comms', 'running', '2026-09-28', 9, 'scorecard 2026-09-28')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  const plans = db.prepare('SELECT * FROM plans').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, url: null, published_at: null })))
  expect(db.prepare('SELECT * FROM plans').all()).toEqual(plans.map((p) => ({ ...p, held_until: null })))
  db.prepare("UPDATE plans SET step = 10, state = 'done' WHERE id = 1").run()
  const insert = db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (?, 'scorecard', ?, 'proof', 't', '', 'b', '[]', '[]', '2026-09-28', '2026-09-28')`)
  insert.run(2, 'scorecard')
  expect(() => insert.run(3, 'blog')).toThrow(/CHECK constraint failed/)
})

it('0085 keeps desk posts, adds url and published_at as NULL', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0084-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0085')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (1, 'ship', 'site', 'approved', 't', 'd', 'b', '[]', '[]', '2026-10-01', '2026-10-02')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, url: null, published_at: null })))
})

it('D5 0087 keeps desk posts, admits dest paste, not blog', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0086-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0087')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, edited_title, edited_dek, edited_body, note,
    sources, checks, work_date, written_date, "order", proof_at, url, published_at)
    VALUES (1, 'weekly', 'substack', 'approved', 't', 'd', 'b', 'et', 'ed', 'eb', 'n', '["s"]', '["c"]', '2026-10-01', '2026-10-02', 3,
    '2026-10-02 10:00:00', 'https://caliperforge.com/blog/06_t.html', '2026-10-03 10:00:00')`).run()
  const before = db.prepare('SELECT * FROM desk_posts').all() as object[]
  expect(migrate(db, join(root, 'schema'))).toEqual(['0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before)
  const insert = db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (?, 'paste', ?, 'proof', 't', 'd', 'b', '[]', '[]', '2026-10-01', '2026-10-04')`)
  insert.run(2, 'paste')
  expect(() => insert.run(3, 'blog')).toThrow(/CHECK constraint failed/)
})

it('D1 D2 0089 drops verdicts.quick_lane', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect((db.pragma('table_info(verdicts)') as { name: string }[]).map((c) => c.name)).not.toContain('quick_lane')
  expect(db.pragma('user_version', { simple: true })).toBe(92)
  expect(() => db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, tokens, seconds, quick_lane)
    VALUES ('review', 'review', printf('%064d', 0), 1, 4, 'pass', 0, 0, 1)`)).toThrow(/no column named quick_lane/)
})

it('D3 0089 keeps a quick_lane verdict and its other columns', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0088-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0089')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.pragma('foreign_keys = OFF')
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree,
    quick_lane, message) VALUES ('review', 'review', printf('%064d', 0), 1, 4, 'refuse', 'ruling', 'r', 7, 1.5, printf('%040d', 0), 1, 'm')`).run()
  const before = db.prepare('SELECT * FROM verdicts').get() as Record<string, unknown>
  expect(before.quick_lane).toBe(1)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  delete before.quick_lane
  expect(db.prepare('SELECT * FROM verdicts').all()).toEqual([before])
})

it('D1 0090 moves coo_lite.apply to director.apply', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0089-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0090')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  addSetting(db, { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-10-04' })
  expect(migrate(db, join(root, 'schema'))).toEqual(['0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(setting(db, 'director.apply')).toBe('1')
  expect(setting(db, 'coo_lite.apply')).toBeUndefined()
})

it('D5 0076 seeds Opus prices, prices past runs at 1-hour', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0075-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0076')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  db.pragma('foreign_keys = OFF')
  const seed = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_write_tokens,
    cache_read_tokens, output_tokens, seconds, exit, at, transcript_path) VALUES (1, 2, 'typescript_specialist', printf('%064d', 0),
    'claude-agent-sdk', ?, 'high', 35266, ?, 2139, 1234, 1, 0, '2026-09-30 00:00:00', 'x.transcript.jsonl')`)
  seed.run('claude-opus-5-5', 20089)
  seed.run('m', 20089)
  seed.run('claude-opus-5-5', null)
  expect(migrate(db, join(root, 'schema'))).toEqual(['0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql'])
  expect(db.prepare('SELECT model, input, cache_write, cache_write_1h, cache_read, output FROM prices ORDER BY model').raw().all())
    .toEqual([['claude-opus-5', 5, 6.25, 10, 0.5, 25], ['claude-opus-5-5', 4, 5, 8, 0.2, 20]])
  const runs = db.prepare('SELECT cache_write_1h_tokens, cost_computed_usd FROM runs ORDER BY id').raw().all() as [number | null, number | null][]
  expect(runs.map(([write1h]) => write1h)).toEqual([20089, 20089, null])
  expect(runs[0]?.[1]).toBeCloseTo(0.2465278, 7)
  expect(runs.slice(1).map(([, cost]) => cost)).toEqual([null, null])
})

it('holds a comms title to one plan and ignores untitled ones', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const comms = (title: string | null): unknown => db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, title)
    VALUES ((SELECT id FROM pipes WHERE name = 'comms'), 'comms', 'queued', '2026-09-27T00:00:00.000Z', 0, 0, ?)`).run(title)
  comms('daily 2026-09-27')
  comms(null)
  comms(null)
  expect(() => comms('daily 2026-09-27')).toThrow(/UNIQUE/)
})

it('D3 a part keeps its given after, or null when given none', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const parent = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  addPart(db, { parent, n: 0, url: 'https://github.com/a/b/issues/2', title: 't', body: 'b' })
  addPart(db, { parent, n: 1, url: 'https://github.com/a/b/issues/3', title: 't', body: 'b', after: 0 })
  expect(allParts(db).map((p) => p.after)).toEqual([null, 0])
})

it('D5: end clears wait_reason and waits_on on every end', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const other = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/2', step: 0 })
  const wait = (): unknown => db.prepare("UPDATE plans SET wait_reason = 'file_overlap', waits_on = ? WHERE id = ?").run(other, plan)
  const row = (): unknown => db.prepare('SELECT state, wait_reason, waits_on FROM plans WHERE id = ?').get(plan)
  const halts = [{ actor: 'tick', outcome: 'refuse', message: 'issue 1 closed' }]
  wait()
  end(db, plan, 'halted', 'issue 1 closed')
  expect(row()).toEqual({ state: 'halted', wait_reason: null, waits_on: null })
  expect(eventsOf(db, plan, 'halted')).toEqual(halts)
  wait()
  end(db, plan, 'refused')
  expect(row()).toEqual({ state: 'refused', wait_reason: null, waits_on: null })
  wait()
  end(db, plan, 'done')
  expect(row()).toEqual({ state: 'done', wait_reason: null, waits_on: null })
  expect(eventsOf(db, plan, 'halted')).toEqual(halts)
  expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
})

it('D1 D5 requeue/clearWaitsOn/holdOn/briefed set their columns', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 4 })
  const other = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/2', step: 0 })
  const row = (cols: string): unknown => db.prepare(`SELECT ${cols} FROM plans WHERE id = ?`).get(plan)
  requeue(db, plan, 2)
  expect(row('step, state')).toEqual({ step: 2, state: 'queued' })
  db.prepare("UPDATE plans SET held_why = 'kept' WHERE id = ?").run(plan)
  holdOn(db, plan, 'parked\nmore', null)
  expect(row('state, waits_on, held_why')).toEqual({ state: 'blocked_on_ceo', waits_on: null, held_why: 'kept' })
  holdOn(db, plan, 'waits\nmore', other)
  expect(row('state, waits_on, held_why')).toEqual({ state: 'blocked_on_ceo', waits_on: other, held_why: 'waits' })
  clearWaitsOn(db, plan)
  expect(row('waits_on, held_why')).toEqual({ waits_on: null, held_why: 'waits' })
  briefed(db, plan, { title: 't', what: 'w', why: null, ends: 'e' })
  expect(row('title, what, why, ends')).toEqual({ title: 't', what: 'w', why: null, ends: 'e' })
})

it('D1 0082 holdOn stores held_until; leaving the hold clears it', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 4 })
  const until = (): unknown => db.prepare('SELECT held_until FROM plans WHERE id = ?').get(plan)
  holdOn(db, plan, 'recheck', null, '2026-10-04T22:00:00.000Z')
  expect(until()).toEqual({ held_until: '2026-10-04T22:00:00.000Z' })
  requeue(db, plan, 4)
  expect(until()).toEqual({ held_until: null })
})

it('D4 resume skips unblocked plans, enters blocked ones by pipe', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare('UPDATE pipes SET max_concurrent = 1 WHERE id = 1').run()
  const plan = (no: number, from: 'queued' | 'blocked_on_ceo'): number => addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path',
    state: from, queued_at: '2026-09-27T00:00:00.000Z', lane: 'machine', seat: 'typescript_specialist',
    origin: `https://github.com/caliperforge/caliperforge/issues/${String(no)}`, step: 2 })
  const state = (id: number): unknown => (db.prepare('SELECT state FROM plans WHERE id = ?').get(id) as { state: string }).state
  const queued = plan(1, 'queued')
  resume(db, queued)
  expect(state(queued)).toBe('queued')
  const blocked = plan(2, 'blocked_on_ceo')
  resume(db, blocked)
  expect(state(blocked)).toBe('running')
  const full = plan(3, 'blocked_on_ceo')
  resume(db, full)
  expect(state(full)).toBe('queued')
})

it('D3 no non-test .ts outside store/ and schema/ writes plans', () => {
  const writers = walk(root, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((path) => relative(root, path).split(sep))
    .filter((parts) => !['store', 'schema'].includes(parts[0] ?? '') && !parts.includes('tests'))
    .map((parts) => parts.join('/'))
    .filter((path) => readFileSync(join(root, path), 'utf8').includes('UPDATE plans'))
  expect(writers).toEqual([])
})

it('D1-D4 coo_lite and director build nothing; no self-review', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  for (const seat of ['coo_lite', 'director', 'typescript_specialist']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'rules/seats.yaml', ?, '2026-09-27')").run(seat, 'a'.repeat(64))
  }
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const run = (step: number, seat: string): unknown => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (?, ?, ?, ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`).run(plan, step, seat, '0'.repeat(64))
  for (const step of [2, 4, 5]) for (const seat of ['coo_lite', 'director']) run(step, seat)
  expect(builderRan(db, plan)).toBe(false)
  run(2, 'typescript_specialist')
  expect(() => run(4, 'typescript_specialist')).toThrow(/reviewer != builder/)
})

it('D1-D3 0084 refuses a review run in the build session', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare("INSERT INTO rules VALUES ('swift_specialist', 'card', 'rules/seats.yaml', ?, '2026-10-04')").run('a'.repeat(64))
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-04T00:00:00.000Z',
    lane: 'machine', seat: 'swift_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const run = (step: number, mode: string | null, session: string | null): number => Number(db.prepare(`INSERT INTO runs (plan, step, seat,
    rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path, mode, session)
    VALUES (?, ?, 'swift_specialist', ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, 'x.transcript.jsonl', ?, ?)`)
    .run(plan, step, '0'.repeat(64), mode, session).lastInsertRowid)
  expect(() => run(2, 'nope', 's')).toThrow(/CHECK constraint failed/)
  run(2, null, 's')
  run(2, null, null)
  expect(() => run(4, 'review', 's')).toThrow(/reviewer != builder/)
  const other = run(4, 'review', 't')
  run(4, 'review', null)
  expect(() => db.prepare("UPDATE runs SET session = 's' WHERE id = ?").run(other)).toThrow(/reviewer != builder/)
})

it('D4: a size limit of 0 lines is refused', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(() => { setLimit(db, { repo: 'acme/widget', lines: 0, origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' }) }).toThrow(/CHECK/)
})

it('D5: addSetting on an existing key throws, keeps the value', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const row = { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' } as const
  addSetting(db, row)
  expect(() => { addSetting(db, { ...row, value: '0' }) }).toThrow(/UNIQUE|PRIMARY/)
  expect(setting(db, 'coo_lite.apply')).toBe('1')
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
