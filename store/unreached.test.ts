import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { missed, reached } from './unreached.ts'

test('missed counts a spell; reached returns and clears it', () => {
  const db = fresh(join(import.meta.dirname, '..', 'schema'))
  const plan = planRow(db)
  expect([missed(db, plan), missed(db, plan), missed(db, plan)]).toEqual([1, 2, 3])
  expect(reached(db, plan)).toBe(3)
  expect(reached(db, plan)).toBe(0)
})
