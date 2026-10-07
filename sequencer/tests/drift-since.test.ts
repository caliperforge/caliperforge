import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
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

test('D1 a plan queued before the gap is not silent', () => {
  expect(drift(queued('2026-09-25'), PYTHON, NOW)).toEqual([])
})

test('D2 a plan queued inside the gap is silent', () => {
  expect(drift(queued('2026-10-02'), PYTHON, NOW)).toEqual([
    { name: 'python_review', state: 'silent', detail: "no row in runs WHERE seat = 'python_specialist' AND mode = 'review'" },
  ])
})

test('D3 with no gap the while window is 7d', () => {
  expect(drift(queued('2026-09-25'), [ANY], NOW)).toEqual([])
  expect(drift(queued('2026-10-02'), [ANY], NOW)).toEqual([{ name: 'any', state: 'silent', detail: 'no row in runs' }])
})
