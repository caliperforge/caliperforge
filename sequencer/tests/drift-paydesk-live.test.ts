import { expect, test } from 'vitest'
import { logged } from '../../store/events.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const live = REGISTRY.filter((e) => e.name === 'paydesk_live')

const pass = (d: ReturnType<typeof db>, at: string, outcome: 'pass' | 'refuse' = 'pass'): number =>
  logged(d, { plan: null, kind: 'paydesk_live', actor: 'paydesk', outcome, message: 'm', pointer: at.slice(0, 10), run: null }, at)

test('D4 paydesk_live is stale with no pass in 8 days', () => {
  const d = db()
  pass(d, '2026-09-24 10:00:00')
  pass(d, '2026-09-30 10:00:00', 'refuse')
  expect(drift(d, live, NOW).map((r) => r.state)).toEqual(['stale'])
  pass(d, '2026-09-26 10:00:00')
  expect(drift(d, live, NOW)).toEqual([])
})
