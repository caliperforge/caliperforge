import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql'])
  expect(db.prepare('SELECT model, input, cache_write, cache_write_1h, cache_read, output FROM prices ORDER BY model').raw().all())
    .toEqual([['claude-opus-5', 5, 6.25, 10, 0.5, 25], ['claude-opus-5-5', 4, 5, 8, 0.2, 20]])
  const runs = db.prepare('SELECT cache_write_1h_tokens, cost_computed_usd FROM runs ORDER BY id').raw().all() as [number | null, number | null][]
  expect(runs.map(([write1h]) => write1h)).toEqual([20089, 20089, null])
  expect(runs[0]?.[1]).toBeCloseTo(0.2465278, 7)
  expect(runs.slice(1).map(([, cost]) => cost)).toEqual([null, null])
})
