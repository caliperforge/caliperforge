import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql', '0097_unreached.sql', '0098_runs_mode_catchup.sql', '0099_ticket_wave.sql', '0100_desk_release.sql', '0101_bench_lane.sql', '0102_bench_scorecard.sql', '0103_bench_template.sql', '0104_site_lane.sql', '0105_account_template.sql', '0106_review_mode_backfill.sql', '0107_loupe_lane.sql', '0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql', '0111_science_lanes.sql', '0112_bench_untested_nullable.sql', '0113_bench_score_busy.sql', '0114_bench_rescore.sql', '0115_records_outside.sql', '0116_records_ball.sql', '0117_bench_calls.sql', '0118_bench_not_powered.sql', '0119_bench_few_properties.sql', '0120_bench_compile_failed.sql', '0121_refuzz_pipe.sql', '0122_bench_night.sql', '0123_runs_phase.sql', '0124_refusal_base.sql', '0125_prices_sonnet.sql', '0126_runs_mode_handback.sql'])
  expect(db.prepare("SELECT * FROM settings WHERE key NOT IN ('comms.story_dir', 'ratchet.mode', 'science.dir', 'science.at') ORDER BY key").all())
    .toEqual(before)
  expect(get(db, 'comms.story_dir')).toBe('~/cf_comms/story')
})
