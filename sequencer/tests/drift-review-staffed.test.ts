import { expect, test } from 'vitest'
import { runAt } from '../../store/events.ts'
import { strays } from '../../store/files.ts'
import { addRule, type Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

const SWIFT = REGISTRY.filter((e) => e.name === 'swift_review')
const KOTLIN = REGISTRY.filter((e) => e.name === 'kotlin_review')
const RUBY = REGISTRY.filter((e) => e.name === 'ruby_review')
const RULE = { kind: 'card' as const, path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' }

function planned(path: string): Db {
  const d = db()
  work(d, 5, path)
  addRule(d, { id: 'code_quality', ...RULE })
  return d
}

function ran(d: Db, mode: string, at: string): number {
  const id = runAt(d, 1, 4, 'code_quality', at)
  d.exec(`UPDATE runs SET mode = '${mode}' WHERE id = ${String(id)}`)
  return id
}

function review(d: Db, staffed: string, at: string): void {
  d.exec(`UPDATE runs SET staffed = '${staffed}' WHERE id = ${String(ran(d, 'review', at))}`)
}

test('D1 an old swift review with a fix run in the gap is quiet', () => {
  const d = planned('App.swift')
  review(d, 'swift_specialist', '2026-09-20 10:00:00')
  ran(d, 'fix', '2026-10-02 10:00:00')
  expect(drift(d, SWIFT, NOW)).toEqual([])
})

test('D2 a review run with only seat set does not count', () => {
  const d = planned('App.swift')
  addRule(d, { id: 'swift_specialist', ...RULE })
  d.exec(`UPDATE runs SET mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'swift_specialist', '2026-10-02 10:00:00'))}`)
  expect(drift(d, SWIFT, NOW)).toEqual([{ name: 'swift_review', state: 'silent',
    detail: "no row in runs WHERE staffed = 'swift_specialist' AND mode = 'review'" }])
})

test('D3 a ruby review in the gap needs a fresh staffed review', () => {
  const ruby = (at: string): Db => {
    const d = planned('app.rb')
    ran(d, 'review', '2026-10-02 10:00:00')
    review(d, 'ruby_specialist', at)
    return d
  }
  expect(drift(ruby('2026-09-20 10:00:00'), RUBY, NOW).map((r) => r.state)).toEqual(['stale'])
  expect(drift(ruby('2026-10-02 11:00:00'), RUBY, NOW)).toEqual([])
})

test('D5 .kt and .kts plans count, a stray .swift path does not', () => {
  for (const path of ['App.kt', 'build.gradle.kts']) {
    const d = planned(path)
    ran(d, 'review', '2026-10-02 10:00:00')
    expect(drift(d, KOTLIN, NOW).map((r) => r.state)).toEqual(['silent'])
  }
  const d = db()
  addRule(d, { id: 'code_quality', ...RULE })
  strays(d, 1, ['App.swift'])
  ran(d, 'review', '2026-10-02 10:00:00')
  expect(drift(d, SWIFT, NOW)).toEqual([])
})
