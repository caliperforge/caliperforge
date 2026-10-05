import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY, work } from './drifting.ts'

test('silentNeedsWork', () => {
  const go = REGISTRY.filter((e) => e.name === 'go_review')
  const d = db()
  expect(drift(d, go, NOW)).toEqual([])
  work(d, 5, 'main.go')
  expect(drift(d, go, NOW)).toEqual([{ name: 'go_review', state: 'silent', detail: "no row in runs WHERE seat = 'go_specialist' AND mode = 'review'" }])
})
