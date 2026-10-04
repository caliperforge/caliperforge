import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addRule, migrate, open } from '../../store/index.ts'
import { addPlan, PlanRow } from '../../store/plans.ts'
import { recordListing } from '../../store/tickets.ts'
import { released } from '../fixer.ts'
import { maybe } from '../workspace.ts'
import { measure } from '../steps.ts'

const repo = join(import.meta.dirname, '../..')
const home = 'caliperforge/caliperforge'
const now = new Date('2026-09-28T09:00:00.000Z')

function listing(number: number, body: string, closedAt: string | null = null) {
  return { number, title: `t${String(number)}`, body, url: `https://github.com/${home}/issues/${String(number)}`,
    labels: [{ name: 'lane:machine' }], createdAt: '2026-09-27', closedAt, stateReason: null }
}

function seeded(first: { state: PlanRow['state']; closedAt?: string } | null) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec("INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent) VALUES (9, 'after', 1, '00:00', '23:59', 2)")
  recordListing(db, home, [listing(1, 'first', first?.closedAt ?? null), listing(2, 'second\n\nAfter: #1\n')], false)
  const plan = (no: number, state: PlanRow['state']) => addPlan(db, { pipe_id: 9, target_id: null, template: 'pr_path', state,
    queued_at: '2026-09-28', lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/${home}/issues/${String(no)}`, step: 0 })
  const one = first === null ? null : plan(1, first.state)
  const two = plan(2, 'running')
  return { db, root: mkdtempSync(join(tmpdir(), 'cf-after-')), one, two }
}

type Db = ReturnType<typeof open>
const row = (db: Db, id: number) => db.prepare('SELECT state, step, waits_on, held_by, held_why FROM plans WHERE id = ?').get(id)
const plan = (db: Db, id: number) => PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
const pushed = (db: Db, id: number) => {
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-28' })
  pushedRow(db, { plan: id, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: `https://github.com/${home}/pull/1` }, gates(db, id, 'd'.repeat(64)))
}

test('D1 an After issue in flight waits on its plan at step 0', () => {
  const { db, root, one, two } = seeded({ state: 'running' })
  expect(measure(db, root, plan(db, two))).toMatchObject({ outcome: 'pass', held: true, spans: ['#1'] })
  expect(row(db, two)).toMatchObject({ state: 'blocked_on_ceo', step: 0, waits_on: one })
  expect(maybe(root, two, 'parked.md')).toContain('#1')
})

test('D2 back to its lane once After lands, then passes measure', () => {
  const { db, root, one, two } = seeded({ state: 'running' })
  measure(db, root, plan(db, two))
  db.prepare("UPDATE plans SET state = 'done' WHERE id = ?").run(one)
  pushed(db, one ?? 0)
  released(db, root, now, () => undefined)
  expect(row(db, two)).toMatchObject({ state: 'queued', step: 0, waits_on: null })
  const again = measure(db, root, plan(db, two))
  expect(again.outcome).toBe('pass')
  expect(again.held).toBeUndefined()
})

test('D4 an After done with no push does not pass measure', () => {
  const { db, root, two } = seeded({ state: 'done' })
  expect(measure(db, root, plan(db, two))).toMatchObject({ outcome: 'pass', held: true, spans: ['#1'] })
  expect(row(db, two)).toMatchObject({ state: 'blocked_on_ceo', step: 0 })
})

test('D3 an After closed unlanded or planless holds for the COO', () => {
  const closed = seeded({ state: 'halted', closedAt: '2026-09-28' })
  expect(measure(closed.db, closed.root, plan(closed.db, closed.two)).held).toBe(true)
  expect(row(closed.db, closed.two)).toEqual({ state: 'blocked_on_ceo', step: 0, waits_on: null, held_by: 'coo',
    held_why: `#1 closed without plan ${String(closed.one)} landing` })
  expect(maybe(closed.root, closed.two, 'parked.md')).toBeNull()
  const none = seeded(null)
  expect(measure(none.db, none.root, plan(none.db, none.two)).held).toBe(true)
  expect(row(none.db, none.two)).toEqual({ state: 'blocked_on_ceo', step: 0, waits_on: null, held_by: 'coo', held_why: '#1 has no plan' })
  expect(maybe(none.root, none.two, 'parked.md')).toBeNull()
})

test('D4 an After refused leaves its reason with the COO', () => {
  const { db, root, one, two } = seeded({ state: 'running' })
  measure(db, root, plan(db, two))
  db.prepare("UPDATE plans SET state = 'refused' WHERE id = ?").run(one)
  released(db, root, now, () => undefined)
  expect(row(db, two)).toEqual({ state: 'blocked_on_ceo', step: 0, waits_on: null, held_by: 'coo',
    held_why: `plan ${String(one)}, which this job waits on, ended refused` })
})
