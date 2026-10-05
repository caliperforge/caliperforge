import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { addFinding, closeFinding, findings } from './drift.ts'
import { migrate, open } from './index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

it('D4 D5 0093 holds one open finding per name; close is once', () => {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  const now = new Date('2026-10-05T11:30:00Z')
  const id = addFinding(db, { name: 'desk', state: 'off', detail: 'd' }, now) ?? 0
  expect(addFinding(db, { name: 'desk', state: 'stale', detail: 'e' }, now)).toBeNull()
  expect(() => db.prepare("INSERT INTO drift_findings (name, state, detail, found_at) VALUES ('desk', 'off', 'd', 't')").run()).toThrow(/UNIQUE/)
  const closed = (outcome: string | null, why: string | null, at: string | null): unknown => db.prepare(`INSERT INTO drift_findings
    (name, state, detail, found_at, outcome, why, closed_at) VALUES ('hq', 'off', 'd', 't', ?, ?, ?)`).run(outcome, why, at)
  expect(() => closed('wontfix', 'w', 't')).toThrow(/CHECK/)
  expect(() => closed('fixed', null, 't')).toThrow(/CHECK/)
  expect(() => closed(null, 'w', null)).toThrow(/CHECK/)
  expect(() => closed('fixed', 'w', null)).toThrow(/CHECK/)
  closeFinding(db, id, 'covered', 'w', 'r', now)
  const before = findings(db)
  closeFinding(db, id, 'defect', 'x', null, new Date('2026-10-06T11:30:00Z'))
  expect(findings(db)).toEqual(before)
  expect(before).toEqual([{ id, name: 'desk', state: 'off', detail: 'd', found_at: now.toISOString(), outcome: 'covered', why: 'w', ref: 'r',
    closed_at: now.toISOString() }])
})
