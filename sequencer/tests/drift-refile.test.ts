import { expect, test } from 'vitest'
import { addFinding, closeFinding, findings } from '../../store/drift.ts'
import { logged } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { drift, due } from '../drift.ts'
import { db, REGISTRY, unread } from './drifting.ts'

const REACH = REGISTRY.filter((e) => e.name === 'director_fix_reach')
const REFILE = REGISTRY.filter((e) => e.name === 'drift_refile')
const DESK = [{ name: 'desk', switch: { key: 'comms.site_dir' } }]
const day = (dd: string): Date => new Date(`2026-10-${dd}T11:30:00Z`)

function failed(d: Db, at: string): void {
  logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'needs_ceo', message: 'fix did not apply: x', pointer: null, run: null }, at)
}

test('D1-D2 a fixed seen finding waits for newer evidence', () => {
  const d = db()
  failed(d, '2026-10-05 10:00:00')
  expect(due(d, REACH, day('08'), unread)).toEqual([1])
  closeFinding(d, 1, 'fixed', 'reach widened', null, day('09'))
  expect(due(d, REACH, day('10'), unread)).toEqual([])
  failed(d, '2026-10-10 12:00:00')
  expect(due(d, REACH, day('11'), unread)).toEqual([2])
})

test('D3 a covered finding waits while its plan is open', () => {
  const d = db()
  expect(due(d, DESK, day('03'), unread)).toEqual([1])
  closeFinding(d, 1, 'covered', 'ticketed', 'https://github.com/a/b/issues/1', day('04'))
  expect(due(d, DESK, day('05'), unread)).toEqual([])
  d.exec("UPDATE plans SET state = 'done' WHERE id = 1")
  expect(due(d, DESK, day('06'), unread)).toEqual([2])
})

test('D5 drift_refile sees a repeat after fixed, not covered', () => {
  const repeat = (outcome: 'fixed' | 'covered'): Db => {
    const d = db()
    const found = { name: 'director_fix_reach', state: 'seen' as const, detail: 'newest events.at is 2026-10-05 10:00:00' }
    addFinding(d, found, day('08'))
    closeFinding(d, 1, outcome, 'w', 'https://github.com/a/b/issues/1', day('09'))
    addFinding(d, found, day('10'))
    expect(findings(d)).toHaveLength(2)
    return d
  }
  expect(drift(repeat('fixed'), REFILE, day('10'))).toMatchObject([{ name: 'drift_refile', state: 'seen' }])
  expect(drift(repeat('covered'), REFILE, day('10'))).toEqual([])
})
