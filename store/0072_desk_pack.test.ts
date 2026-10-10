import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0072_desk_pack.sql', '0073_desk_scorecard.sql', '0075_queue_order.sql', '0076_prices_opus.sql', '0077_director_actor.sql', '0078_drift_at.sql', '0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql', '0097_unreached.sql'])
  expect(db.prepare('SELECT * FROM desk_posts').all()).toEqual(before.map((p) => ({ ...p, url: null, published_at: null })))
  const insert = db.prepare(`INSERT INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date)
    VALUES (?, 'growth', ?, 'proof', 't', '', 'b', '[]', '[]', '2026-09-28', '2026-09-28')`)
  insert.run(2, 'pack')
  expect(() => insert.run(3, 'blog')).toThrow(/CHECK constraint failed/)
})
