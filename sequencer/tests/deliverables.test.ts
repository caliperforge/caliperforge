import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { gates } from '../../store/approvals.ts'
import { gated, passedDiff, pushedRow } from '../../store/deliverables.ts'
import { addRule } from '../../store/index.ts'
import { addPlan } from '../../store/plans.ts'

const SEAT = 'typescript_specialist'
const PASSED = 'a'.repeat(64)
const ALL = { tests_pass: true, byte_identical_elsewhere: true, fork_ci_green: true, bot_clean: true, target_warm: true }

function planned() {
  const db = fresh(join(import.meta.dirname, '../../schema'))
  addPlan(db, { pipe_id: 1, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-22', lane: 'machine',
    seat: SEAT, origin: 'https://github.com/caliperforge/caliperforge/issues/50', step: 5 })
  addRule(db, { id: SEAT, kind: 'roster', path: `seats/${SEAT}`, content_hash: '0'.repeat(64), loaded_at: '2026-10-01' })
  return db
}

test('passedDiff skips a newer row at another step', () => {
  const db = planned()
  gated(db, { plan: 1, step: 5, seat: SEAT, diff_digest: PASSED, evidence: 'gated' }, ALL)
  const made = { plan: 1, step: 6, seat: SEAT, diff_digest: 'b'.repeat(64), evidence: 'pushed' }
  pushedRow(db, made, gates(db, 1, made.diff_digest))
  expect(passedDiff(db, 1)).toBe(PASSED)
})

test('passedDiff is null with no step-5 row', () => {
  const db = planned()
  gated(db, { plan: 1, step: 3, seat: SEAT, diff_digest: PASSED, evidence: 'gated' }, ALL)
  expect(passedDiff(db, 1)).toBeNull()
})
