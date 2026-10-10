import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { addSetting, setting } from './drift.ts'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D1 0090 moves coo_lite.apply to director.apply', () => {
  const old = mkdtempSync(join(tmpdir(), 'cf-0089-'))
  for (const file of readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.sql') && f < '0090')) {
    copyFileSync(join(root, 'schema', file), join(old, file))
  }
  const db = open(':memory:')
  migrate(db, old)
  addSetting(db, { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-10-04' })
  expect(migrate(db, join(root, 'schema'))).toEqual(['0090_director_apply.sql', '0091_runs_mode_writer.sql', '0092_decisions_widen.sql', '0093_drift_findings.sql', '0094_runs_staffed.sql', '0095_events_escalate.sql', '0096_verdicts_blind.sql', '0097_unreached.sql'])
  expect(setting(db, 'director.apply')).toBe('1')
  expect(setting(db, 'coo_lite.apply')).toBeUndefined()
})
