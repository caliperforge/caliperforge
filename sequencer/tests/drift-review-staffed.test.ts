import { expect, test } from 'vitest'
import { runAt } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

const SWIFT = REGISTRY.filter((e) => e.name === 'swift_review')
const RUBY = REGISTRY.filter((e) => e.name === 'ruby_review')
const RULE = { kind: 'card' as const, path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' }

function planned(path: string, state: string): Db {
  const d = db()
  work(d, 5, path)
  d.exec(`UPDATE plans SET state = '${state}' WHERE id = 1`)
  addRule(d, { id: 'code_quality', ...RULE })
  return d
}

function review(d: Db, staffed: string, at: string): void {
  d.exec(`UPDATE runs SET staffed = '${staffed}', mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'code_quality', at))}`)
}

test('D1 a done swift plan with no run in the gap is quiet', () => {
  expect(drift(planned('App.swift', 'done'), SWIFT, NOW)).toEqual([])
})

test('D2 an open swift plan with an old staffed review is stale', () => {
  const d = planned('App.swift', 'queued')
  review(d, 'swift_specialist', '2026-09-20 10:00:00')
  expect(drift(d, SWIFT, NOW)).toEqual([{ name: 'swift_review', state: 'stale',
    detail: 'newest runs.at is 2026-09-20 10:00:00, older than 7d', newest: '2026-09-20 10:00:00' }])
})

test('D3 a review run with only seat set does not count', () => {
  const d = planned('App.swift', 'queued')
  addRule(d, { id: 'swift_specialist', ...RULE })
  d.exec(`UPDATE runs SET mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'swift_specialist', '2026-10-02 10:00:00'))}`)
  expect(drift(d, SWIFT, NOW)).toEqual([{ name: 'swift_review', state: 'silent',
    detail: "no row in runs WHERE staffed = 'swift_specialist' AND mode = 'review'" }])
})

test('D4 a done ruby plan run in the gap needs a fresh review', () => {
  const ruby = (at: string): Db => {
    const d = planned('app.rb', 'done')
    runAt(d, 1, 3, 'code_quality', '2026-10-02 10:00:00')
    review(d, 'ruby_specialist', at)
    return d
  }
  expect(drift(ruby('2026-09-20 10:00:00'), RUBY, NOW).map((r) => r.state)).toEqual(['stale'])
  expect(drift(ruby('2026-10-02 11:00:00'), RUBY, NOW)).toEqual([])
})
