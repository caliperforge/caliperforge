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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0079_story_dir.sql', '0080_ratchet_mode.sql', '0081_science_dir.sql', '0082_held_until.sql', '0083_science_at.sql', '0084_runs_mode_session.sql', '0085_desk_url.sql', '0086_language_notes.sql', '0087_desk_paste.sql', '0088_refusal_note.sql', '0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql'])
  expect(db.prepare("SELECT * FROM settings WHERE key NOT IN ('comms.story_dir', 'ratchet.mode', 'science.dir', 'science.at') ORDER BY key").all())
    .toEqual(before)
  expect(get(db, 'comms.story_dir')).toBe('~/cf_comms/story')
})
