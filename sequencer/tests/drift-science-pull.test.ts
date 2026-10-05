import { expect, test } from 'vitest'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D4 science_pull reads only pass events, stale after 7d', () => {
  const science = REGISTRY.filter((e) => e.name === 'science_pull')
  const d = db()
  const pulled = (at: string, outcome: string): void => {
    d.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (NULL, ?, 'science_pull', 'science', ?, 'm')").run(at, outcome)
  }
  expect(drift(d, science, NOW).map((r) => r.state)).toEqual(['silent'])
  pulled('2026-10-02 10:00:00', 'refuse')
  expect(drift(d, science, NOW).map((r) => r.state)).toEqual(['silent'])
  pulled('2026-09-25 10:00:00', 'pass')
  expect(drift(d, science, NOW).map((r) => r.state)).toEqual(['stale'])
  pulled('2026-09-27 10:00:00', 'pass')
  expect(drift(d, science, NOW)).toEqual([])
})
