import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import type { Db } from './index.ts'
import { newestVerdict, reviewSince } from './reviewed.ts'

const review = (db: Db, plan: number): number => Number(db.prepare(`INSERT INTO verdicts
  (gate, kind, subject_digest, plan, step, outcome, tokens, seconds) VALUES ('review', 'review', ?, ?, 4, 'pass', 0, 0)`)
  .run('0'.repeat(64), plan).lastInsertRowid)

test('D3 newestVerdict is 0 on an empty table', () => {
  expect(newestVerdict(fresh(join(import.meta.dirname, '..', 'schema')))).toBe(0)
})

test('D3 reviewSince skips a review at or below the mark', () => {
  const db = fresh(join(import.meta.dirname, '..', 'schema'))
  const plan = planRow(db)
  const old = review(db, plan)
  expect(reviewSince(db, plan, 4, newestVerdict(db))).toBeNull()
  const own = review(db, plan)
  expect(reviewSince(db, plan, 4, old)).toBe(own)
})
