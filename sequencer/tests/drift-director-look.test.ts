import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D2 director_look is silent until a look, stale after 7d', () => {
  const look = REGISTRY.filter((e) => e.name === 'director_look')
  const d = db()
  const looked = (at: string, kind = 'look'): void => {
    d.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (NULL, ?, ?, 'coo_lite', 'pass', 'm')").run(at, kind)
  }
  looked('2026-10-02 10:00:00', 'coo_lite')
  looked('2026-10-02 10:00:00', 'science_pull')
  expect(drift(d, look, NOW)).toEqual([{ name: 'director_look', state: 'silent', detail: "no row in events WHERE kind = 'look'" }])
  looked('2026-09-25 10:00:00')
  expect(drift(d, look, NOW).map((r) => r.state)).toEqual(['stale'])
  looked('2026-09-27 10:00:00')
  expect(drift(d, look, NOW)).toEqual([])
})
