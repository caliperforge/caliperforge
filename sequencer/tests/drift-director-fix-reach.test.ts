import { expect, test } from 'vitest'
import { logged } from '../../store/events.ts'
import { drift } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

test('D5 director_fix_reach is seen only on a failed fix in 7d', () => {
  const reach = REGISTRY.filter((e) => e.name === 'director_fix_reach')
  const d = db()
  const told = (at: string, kind: string, message: string): void => {
    logged(d, { plan: 1, kind, actor: kind, outcome: 'needs_ceo', message, pointer: null, run: null }, at)
  }
  expect(drift(d, reach, NOW)).toEqual([])
  told('2026-10-02 10:00:00', 'director', 'fix: refused by the fence, the fixer makes no commit')
  expect(drift(d, reach, NOW)).toEqual([])
  told('2026-09-25 10:00:00', 'coo_lite', 'fix did not apply, the fixer did not make the fix: x')
  expect(drift(d, reach, NOW)).toEqual([])
  told('2026-09-27 10:00:00', 'coo_lite', 'fix did not apply, the fixer did not make the fix: y')
  expect(drift(d, reach, NOW)).toEqual([{ name: 'director_fix_reach', state: 'seen',
    detail: 'newest events.at is 2026-09-27 10:00:00, within 7d; expected none', newest: '2026-09-27 10:00:00' }])
  told('2026-10-02 10:00:00', 'director', 'fix did not apply, the fixer did not make the fix: z')
  expect(drift(d, reach, NOW).map((r) => r.detail)).toEqual(['newest events.at is 2026-10-02 10:00:00, within 7d; expected none'])
})
