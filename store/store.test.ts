import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { dump, migrate, open } from './index.ts'
import { get, set, windows } from './lanes.ts'
import { setLimit } from './limits.ts'
import { addPart, allParts } from './parts.ts'
import { addPlan, builderRan } from './plans.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('applies every migration once and records the version', () => {
  const db = open(':memory:')
  expect(migrate(db, join(root, 'schema'))).toEqual(['0001_init.sql', '0002_rulings.sql', '0003_runs_rule_hash.sql', '0004_one_disposition_per_verdict.sql', '0005_tick.sql', '0006_runs_transcript_path.sql', '0007_batch.sql', '0008_head_digest.sql', '0009_open_loop.sql', '0010_lanes.sql', '0011_issue_plans.sql', '0012_feeder.sql', '0013_internal_plans.sql', '0014_adopted_pr.sql', '0015_brief_read.sql', '0017_plan_files.sql', '0018_refusals.sql', '0019_signal_words.sql', '0020_leases.sql', '0021_parts.sql', '0022_band_p95.sql', '0023_reading_holds_ceiling.sql', '0024_run_token_wall.sql', '0025_wait_reason.sql', '0026_decisions.sql', '0027_verdict_tree.sql', '0028_priority_label.sql', '0029_merges.sql', '0030_kept_verdicts.sql', '0031_file_overlap.sql', '0032_stray_files.sql', '0033_quick_lane.sql', '0034_target_part.sql', '0035_caps_skip_cache_reads.sql', '0036_decisions_blocked_on_ceo.sql', '0037_decisions_applied.sql', '0039_events.sql', '0040_hq_path.sql', '0041_signal_head.sql', '0042_now.sql', '0043_reviewer_not_builder_skips_fixer.sql', '0044_tickets.sql', '0045_records.sql', '0046_brief_lines.sql', '0047_runs_cost.sql', '0048_scan_evidence.sql', '0049_part_after.sql', '0050_target_take.sql', '0051_held_by.sql', '0052_ratchet_counts.sql', '0053_tick_lanes.sql', '0054_gardens.sql', '0055_ticket_times.sql', '0056_size_limits.sql', '0057_refusal_ticket.sql', '0058_comms_once.sql', '0059_reviewer_not_builder_skips_coo_lite.sql', '0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql'])
  expect(db.pragma('user_version', { simple: true })).toBe(65)
  expect(migrate(db, join(root, 'schema'))).toEqual([])
})

it('D1: 0064 adds the desk tables and a comms.site_dir that holds a path, and no other key takes one', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(db.prepare('SELECT count(*) AS n FROM desk_posts, desk_learnings').get()).toEqual({ n: 0 })
  expect(get(db, 'comms.site_dir')).toBe('')
  set(db, 'comms.site_dir', '/tmp/site', 'ceo', '2026-09-28')
  expect(get(db, 'comms.site_dir')).toBe('/tmp/site')
  expect(() => { set(db, 'brief.reads_left', '/tmp', 'ceo', '2026-09-28') }).toThrow(/CHECK constraint failed/)
})

it('D1 D5: 0060 to 0062 keep every run total and the cache read CHECK, and split each window by type', () => {
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

  expect(migrate(db, join(root, 'schema'))).toEqual(['0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql'])
  expect(windows(db).map((w) => [w.kind, w.runs, w.tokens])).toEqual(before)
  for (const w of windows(db)) expect(w.uncached_tokens + w.cache_write_tokens + w.cache_read_tokens + w.output_tokens).toBe(w.tokens)
  expect(db.prepare('SELECT sum(input_tokens + cache_read_tokens + output_tokens) AS n FROM runs').get()).toEqual({ n: 638 })
  expect(() => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens,
    output_tokens, seconds, exit, transcript_path) VALUES (3, 2, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'm', 'high',
    0, -1, 0, 1, 0, 'x.transcript.jsonl')`).run()).toThrow(/CHECK constraint failed: cache_read_tokens/)
})

it('holds a comms title to one plan, and leaves untitled comms plans alone', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const comms = (title: string | null): unknown => db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, title)
    VALUES ((SELECT id FROM pipes WHERE name = 'comms'), 'comms', 'queued', '2026-09-27T00:00:00.000Z', 0, 0, ?)`).run(title)
  comms('daily 2026-09-27')
  comms(null)
  comms(null)
  expect(() => comms('daily 2026-09-27')).toThrow(/UNIQUE/)
})

it('D3: a part keeps the after it is given, and null when it is given none', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const parent = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  addPart(db, { parent, n: 0, url: 'https://github.com/a/b/issues/2', title: 't', body: 'b' })
  addPart(db, { parent, n: 1, url: 'https://github.com/a/b/issues/3', title: 't', body: 'b', after: 0 })
  expect(allParts(db).map((p) => p.after)).toEqual([null, 0])
})

it('D1-D3: coo_lite runs at steps 2, 4 and 5 build nothing, and a builder still cannot review itself', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  for (const seat of ['coo_lite', 'typescript_specialist']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'rules/seats.yaml', ?, '2026-09-27')").run(seat, 'a'.repeat(64))
  }
  const plan = addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-27T00:00:00.000Z',
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/1', step: 0 })
  const run = (step: number, seat: string): unknown => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens, seconds, exit, transcript_path)
    VALUES (?, ?, ?, ?, 'anthropic-api', 'm', 'low', 0, 0, 0, 0, 0, 'x.transcript.jsonl')`).run(plan, step, seat, '0'.repeat(64))
  for (const step of [2, 4, 5]) run(step, 'coo_lite')
  expect(builderRan(db, plan)).toBe(false)
  run(2, 'typescript_specialist')
  expect(() => run(4, 'typescript_specialist')).toThrow(/reviewer != builder/)
})

it('D4: a size limit of 0 lines is refused', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect(() => { setLimit(db, { repo: 'acme/widget', lines: 0, origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' }) }).toThrow(/CHECK/)
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
