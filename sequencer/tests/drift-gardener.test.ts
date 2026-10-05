import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { internal, NOW, queue, REGISTRY } from './drifting.ts'

const GARDENER = REGISTRY.filter((e) => e.name === 'gardener')
const STALE = [{ name: 'gardener', state: 'stale', detail: 'newest gardens.day is 2026-09-28, older than 2d' }]

test('gardenerWhile', () => {
  expect(drift(internal(), GARDENER, NOW)).toEqual(STALE)
  const busy = internal()
  queue(busy, 1)
  expect(drift(busy, GARDENER, NOW)).toEqual([])
  const full = internal(1, 1)
  queue(full, 3)
  expect(drift(full, GARDENER, NOW)).toEqual([])
  const open = internal()
  for (const n of [11, 12]) {
    open.exec(`INSERT INTO gardens (day, metric, url) VALUES ('2026-09-${String(n)}', 'prepare', 'https://github.com/a/b/issues/${String(n)}');
      INSERT INTO tickets (repo, number, title, lane) VALUES ('a/b', ${String(n)}, 't', 'machine')`)
  }
  expect(drift(open, GARDENER, NOW)).toEqual([])
  open.exec("UPDATE tickets SET closed_at = '2026-10-01' WHERE number = 11")
  expect(drift(open, GARDENER, NOW)).toEqual(STALE)
  const none = internal()
  none.exec("DELETE FROM pipes WHERE name = 'internal'")
  expect(drift(none, GARDENER, NOW)).toEqual([])
  expect(drift(internal(0), GARDENER, NOW)).toEqual([])
})
