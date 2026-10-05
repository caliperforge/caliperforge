import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { windows } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

  expect(migrate(db, join(root, 'schema'))).toEqual(['0060_cache_read_tokens.sql', '0061_cache_write_tokens.sql', '0062_window_tokens_by_type.sql', '0063_uniswap_lane.sql', '0064_desk.sql', '0065_prices.sql', '0066_parked_why.sql', '0067_outcomes.sql', '0068_band_open_0928.sql', '0069_events_plan_nullable.sql', '0070_ticket_outcomes.sql', '0071_desk_proof_at.sql', '0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql'])
  expect(windows(db).map((w) => [w.kind, w.runs, w.tokens])).toEqual(before)
  for (const w of windows(db)) expect(w.uncached_tokens + w.cache_write_tokens + w.cache_read_tokens + w.output_tokens).toBe(w.tokens)
  expect(db.prepare('SELECT sum(input_tokens + cache_read_tokens + output_tokens) AS n FROM runs').get()).toEqual({ n: 638 })
  expect(() => db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens,
    output_tokens, seconds, exit, transcript_path) VALUES (3, 2, 'typescript_specialist', printf('%064d', 0), 'claude-agent-sdk', 'm', 'high',
    0, -1, 0, 1, 0, 'x.transcript.jsonl')`).run()).toThrow(/CHECK constraint failed: cache_read_tokens/)
})
