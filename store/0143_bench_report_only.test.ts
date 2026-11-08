import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { migrate, open } from './index.ts'
import { get, set } from './lanes.ts'

const schema = resolve(import.meta.dirname, '../schema')

it('0143 seeds report_only_checks empty, takes a comma list', () => {
  const db = open(':memory:')
  migrate(db, schema)
  expect(get(db, 'bench.report_only_checks')).toBe('')
  set(db, 'bench.report_only_checks', 'suite.outside,reach.unmet,reach.boundary', 'ceo', '2026-11-08')
  expect(get(db, 'bench.report_only_checks')).toBe('suite.outside,reach.unmet,reach.boundary')
  set(db, 'bench.report_only_checks', '', 'ceo', '2026-11-08')
  expect(get(db, 'bench.report_only_checks')).toBe('')
})

it.each(['a,b', ''])('0143 still refuses %j on any other key', (value) => {
  const db = open(':memory:')
  migrate(db, schema)
  expect(() => { set(db, 'bench.score_seconds', value, 'ceo', '2026-11-08') }).toThrow(/CHECK constraint failed/)
})
