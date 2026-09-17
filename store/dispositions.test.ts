import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh, rejects } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { load } from '../runner/rules.ts'
import type { Db } from './index.ts'
import { escaped, overridden, owner, settle } from './dispositions.ts'

const root = join(import.meta.dirname, '..')
const evidence = 'https://github.com/caliperforge/caliperforge/issues/8'

function verdict(db: Db, plan: number, outcome: string): number {
  const row = db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES ('review', 'review', ?, ?, 4, ?, NULL, 'ruling', 'review.code_quality', 0, 0)`)
    .run('a'.repeat(64), plan, outcome)
  return Number(row.lastInsertRowid)
}

function bench(): { db: Db; plan: number } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  return { db, plan: planRow(db) }
}

function kindOf(db: Db, id: number): unknown {
  return db.prepare('SELECT kind, owner, defect_class FROM dispositions WHERE id = ?').get(id)
}

test('bytes changed at the span with a passing re-gate is fixed; no byte change is no_change_pass', () => {
  const { db, plan } = bench()
  const span = { verdict_id: verdict(db, plan, 'refuse'), defect_class: 'correctness', evidence }
  const fixed = settle(db, span, 'xs.sort()', '[...xs].sort((a, b) => a - b)', 'pass')
  expect(kindOf(db, fixed ?? 0)).toEqual({ kind: 'fixed', owner: 'review', defect_class: 'correctness' })

  const same = { ...span, verdict_id: verdict(db, plan, 'refuse') }
  const noop = settle(db, same, 'xs.sort()', 'xs.sort()', 'pass')
  expect(kindOf(db, noop ?? 0)).toEqual({ kind: 'no_change_pass', owner: 'review', defect_class: 'correctness' })
})

test('a re-gate that still refuses settles nothing', () => {
  const { db, plan } = bench()
  const span = { verdict_id: verdict(db, plan, 'refuse'), defect_class: 'correctness', evidence }
  expect(settle(db, span, 'a', 'b', 'refuse')).toBeNull()
  expect(db.prepare('SELECT count(*) AS n FROM dispositions').get()).toEqual({ n: 0 })
})

test('escaped is attributed to the owning step and overridden carries the approval row', () => {
  const { db, plan } = bench()
  const miss = escaped(db, { verdict_id: verdict(db, plan, 'pass'), defect_class: 'tight.comment', evidence })
  expect(kindOf(db, miss)).toEqual({ kind: 'escaped', owner: 'step3', defect_class: 'tight.comment' })

  const approval = Number(db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, approved_at)
    VALUES ('override', 1, ?, 'ceo', '2026-09-17')`).run('b'.repeat(64)).lastInsertRowid)
  const over = overridden(db, { verdict_id: verdict(db, plan, 'refuse'), defect_class: 'scope', evidence }, approval, 'false_positive')
  expect(kindOf(db, over)).toEqual({ kind: 'overridden', owner: 'review', defect_class: 'scope' })
})

test('every class in the build map maps to its owning step and an unknown class throws', () => {
  const map: [string, string][] = [
    ['premise', 'step0'], ['secret', 'step3'], ['authority', 'step3'], ['tier', 'step3'], ['claim', 'step3'],
    ['tight.comment', 'step3'], ['test.weakened', 'step3'], ['test.untargeted', 'step3'], ['identifier.unresolved', 'step3'],
    ['correctness', 'review'], ['scope', 'review'], ['approach', 'review'], ['minimal', 'review'],
    ['register', 'text_review'], ['claim.unverified', 'text_review'],
    ['upstream.number', 'text_rail'], ['restated.rail', 'text_rail'],
    ['stale.verdict', 'ready'], ['not.public', 'ready'], ['ci.red', 'ready'], ['no.anchor', 'ready'],
  ]
  for (const [defect, step] of map) expect(owner(defect)).toBe(step)
  expect(() => owner('vibes')).toThrow(/no owning step/)
})

test('the store refuses an owner the class does not own and a second disposition on one verdict', () => {
  const { db, plan } = bench()
  const id = verdict(db, plan, 'refuse')
  expect(rejects(db, `INSERT INTO dispositions (verdict_id, kind, defect_class, owner, evidence)
    VALUES (${String(id)}, 'fixed', 'correctness', 'ready', '${evidence}')`)).toBe(true)
  settle(db, { verdict_id: id, defect_class: 'correctness', evidence }, 'a', 'b', 'pass')
  expect(() => escaped(db, { verdict_id: id, defect_class: 'correctness', evidence })).toThrow(/UNIQUE/)
})
