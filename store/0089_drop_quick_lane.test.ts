import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 D2 0089 drops verdicts.quick_lane', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  expect((db.pragma('table_info(verdicts)') as { name: string }[]).map((c) => c.name)).not.toContain('quick_lane')
  expect(db.pragma('user_version', { simple: true })).toBe(96)
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
  expect(migrate(db, join(root, 'schema'))).toEqual(['0089_drop_quick_lane.sql', '0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql'])
  delete before.quick_lane
  expect(db.prepare('SELECT * FROM verdicts').all()).toEqual([before])
})
