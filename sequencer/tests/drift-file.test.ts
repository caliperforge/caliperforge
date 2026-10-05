import { expect, test } from 'vitest'
import { closeFinding, findings, setting } from '../../store/drift.ts'
import { due } from '../drift.ts'
import { db, unread } from './drifting.ts'

const DESK = [{ name: 'desk', switch: { key: 'comms.site_dir' } }]

test('D1-D3 a gap keeps one open finding until it is closed', () => {
  const d = db()
  const day = (dd: string): Date => new Date(`2026-10-${dd}T11:30:00Z`)
  expect(due(d, DESK, day('03'), unread)).toEqual([1])
  expect(findings(d)).toEqual([{ id: 1, name: 'desk', state: 'off', detail: "comms.site_dir is ''", found_at: '2026-10-03T11:30:00.000Z',
    outcome: null, why: null, ref: null, closed_at: null }])
  expect(due(d, DESK, day('04'), unread)).toEqual([])
  expect(findings(d)).toHaveLength(1)
  closeFinding(d, 1, 'fixed', 'site dir set', null, day('04'))
  expect(due(d, DESK, day('05'), unread)).toEqual([2])
  expect(findings(d).map((f) => [f.id, f.name, f.closed_at])).toEqual([[1, 'desk', '2026-10-04T11:30:00.000Z'], [2, 'desk', null]])
})

test('dailyOnce', () => {
  const d = db()
  const hq = [{ name: 'hq', switch: { key: 'comms.site_dir' } }]
  expect(due(d, DESK, new Date('2026-10-03T11:29:00Z'), unread)).toEqual([])
  expect(due(d, DESK, new Date('2026-10-03T11:30:00Z'), unread)).toEqual([1])
  expect(due(d, hq, new Date('2026-10-04T05:00:00Z'), unread)).toEqual([])
  expect(due(d, hq, new Date('2026-10-04T11:30:00Z'), unread)).toEqual([2])
  expect(setting(d, 'drift.at')).toBe('2026-10-04')
})
