import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('daily_learnings: stale after 2d of no items, comms on', () => {
  const daily = REGISTRY.filter((e) => e.name === 'daily_learnings')
  const learned = (d: Db, date: string, items: string): Db => {
    d.exec(`INSERT INTO desk_learnings (date, numbers, items, sources) VALUES ('${date}', '{}', ${items}, '[]')`)
    return d
  }
  const d = learned(db(), '2026-09-29', 'NULL')
  expect(drift(d, daily, NOW)).toEqual([{ name: 'daily_learnings', state: 'silent',
    detail: 'no row in desk_learnings WHERE json_array_length(items) > 0' }])
  const stale = [{ name: 'daily_learnings', state: 'stale', detail: 'newest desk_learnings.date is 2026-09-30, older than 2d' }]
  expect(drift(learned(d, '2026-09-30', `'["a"]'`), daily, NOW)).toEqual(stale)
  expect(drift(learned(d, '2026-10-02', "'[]'"), daily, NOW)).toEqual(stale)
  expect(drift(learned(db(), '2026-10-02', `'["a"]'`), daily, NOW)).toEqual([])
  expect(drift(learned(db(0), '2026-09-30', `'["a"]'`), daily, NOW)).toEqual([])
})
