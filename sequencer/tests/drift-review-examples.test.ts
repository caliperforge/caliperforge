import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, event, NOW, REGISTRY } from './drifting.ts'

const examples = REGISTRY.filter((e) => e.name === 'review_examples')
const OLD = '2026-09-20T10:00:00Z'

test('review_examples: idle with no greptile.accepted', () => {
  const d = db()
  event(d, OLD, 'examples.learned')
  expect(drift(d, examples, NOW)).toEqual([])
})

test('review_examples: idle when accepted predates learned', () => {
  const d = db()
  event(d, '2026-09-19T10:00:00Z', 'greptile.accepted')
  event(d, OLD, 'examples.learned')
  expect(drift(d, examples, NOW)).toEqual([])
})

test('review_examples: stale when accepted is unlearned', () => {
  const d = db()
  event(d, OLD, 'examples.learned')
  event(d, '2026-10-01T10:00:00Z', 'greptile.accepted')
  expect(drift(d, examples, NOW)).toEqual([{ name: 'review_examples', state: 'stale',
    detail: `newest events.at is ${OLD}, older than 7d`, newest: OLD }])
})

test('review_examples: silent with accepted and no learned', () => {
  const d = db()
  event(d, '2026-10-01T10:00:00Z', 'greptile.accepted')
  expect(drift(d, examples, NOW)).toEqual([{ name: 'review_examples', state: 'silent',
    detail: "no row in events WHERE kind = 'examples.learned'" }])
})
