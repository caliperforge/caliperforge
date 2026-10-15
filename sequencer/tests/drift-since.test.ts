import { expect, test } from 'vitest'
import { runAt } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

const PYTHON = REGISTRY.filter((e) => e.name === 'python_review')
const ANY = { name: 'any', table: 'runs', column: 'at', while: 'EXISTS (SELECT 1 FROM plans WHERE queued_at >= $since)' }

function queued(at: string): Db {
  const d = db()
  work(d, 5, 'main.py')
  d.exec(`UPDATE plans SET queued_at = '${at}' WHERE id = 1`)
  return d
}

test('D4 an open plan with no review in the gap is quiet', () => {
  expect(drift(queued('2026-09-25'), PYTHON, NOW)).toEqual([])
})

test('D4 an unstaffed review in the gap is silent', () => {
  const d = queued('2026-09-25')
  addRule(d, { id: 'code_quality', kind: 'card', path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' })
  d.exec(`UPDATE runs SET mode = 'review' WHERE id = ${String(runAt(d, 1, 4, 'code_quality', '2026-10-02 10:00:00'))}`)
  expect(drift(d, PYTHON, NOW)).toEqual([
    { name: 'python_review', state: 'silent', detail: "no row in runs WHERE staffed = 'python_specialist' AND mode = 'review'" },
  ])
})

test('D5 a done plan with no run inside the gap is quiet', () => {
  const d = queued('2026-09-25')
  d.exec("UPDATE plans SET state = 'done' WHERE id = 1")
  expect(drift(d, PYTHON, NOW)).toEqual([])
})

test('D3 with no gap the while window is 7d', () => {
  expect(drift(queued('2026-09-25'), [ANY], NOW)).toEqual([])
  expect(drift(queued('2026-10-02'), [ANY], NOW)).toEqual([{ name: 'any', state: 'silent', detail: 'no row in runs' }])
})
