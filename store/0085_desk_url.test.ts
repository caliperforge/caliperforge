import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql', '0097_unreached.sql', '0098_runs_mode_catchup.sql', '0099_ticket_wave.sql', '0100_desk_release.sql', '0101_bench_lane.sql', '0102_bench_scorecard.sql', '0103_bench_template.sql', '0104_site_lane.sql', '0105_account_template.sql', '0106_review_mode_backfill.sql', '0107_loupe_lane.sql', '0108_atelier_to_loupe.sql', '0109_retire_atelier_lane.sql', '0110_bench_x_ray.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, url: null, published_at: null, release: null })))
})
