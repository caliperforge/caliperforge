import { expect, test } from 'vitest'
import { addFinding, addSetting, findings } from '../../store/drift.ts'
import { ofKind } from '../../store/events.ts'
import { due, type Entry } from '../drift.ts'
import { db, event, unread } from './drifting.ts'

const day = (dd: string): Date => new Date(`2026-10-${dd}T11:30:00Z`)
const PROBE: Entry[] = [{ name: 'probe', table: 'events', column: 'at', where: "kind = 'probe'" }]
const QUIET: Entry = { name: 'quiet', table: 'events', column: 'at', where: "kind = 'quiet'" }

test('D1 a silent finding closes once its row lands', () => {
  const d = db()
  expect(due(d, PROBE, day('03'), unread)).toEqual([1])
  event(d, '2026-10-03 12:00:00', 'probe')
  expect(due(d, PROBE, day('04'), unread)).toEqual([])
  expect(findings(d)).toEqual([{ id: 1, name: 'probe', state: 'silent', detail: "no row in events WHERE kind = 'probe'",
    found_at: '2026-10-03T11:30:00.000Z', outcome: 'fixed', why: 'recovered: newest events.at is 2026-10-03 12:00:00', ref: null,
    closed_at: '2026-10-04T11:30:00.000Z' }])
  expect(ofKind(d, 'drift')).toEqual([{ plan: null, kind: 'drift', actor: 'drift', outcome: 'pass', message: 'recovered finding 1 probe' }])
})

test('D2 a still-silent finding stays open', () => {
  const d = db()
  expect(due(d, [...PROBE, QUIET], day('03'), unread)).toEqual([1, 2])
  event(d, '2026-10-03 12:00:00', 'probe')
  due(d, [...PROBE, QUIET], day('04'), unread)
  expect(findings(d).map((f) => [f.name, f.outcome])).toEqual([['probe', 'fixed'], ['quiet', null]])
  expect(ofKind(d, 'drift').map((e) => e.message)).toEqual(['recovered finding 1 probe'])
})

test('D3 a seen finding closes once its row passes the gap', () => {
  const d = db()
  const seen: Entry[] = [{ name: 'seen', table: 'events', column: 'at', where: "kind = 'seen'", gap: '2d', expected: 0 }]
  event(d, '2026-10-03 10:00:00', 'seen')
  expect(due(d, seen, day('03'), unread)).toEqual([1])
  due(d, seen, day('04'), unread)
  expect(findings(d)[0]?.closed_at).toBeNull()
  due(d, seen, day('05'), unread)
  expect(findings(d).map((f) => [f.outcome, f.why, f.closed_at]))
    .toEqual([['fixed', 'recovered: newest events.at is 2026-10-03 10:00:00', '2026-10-05T11:30:00.000Z']])
})

test('D4 an off finding closes once its switch reads right', () => {
  const d = db()
  const apply: Entry[] = [{ name: 'apply', switch: { key: 'probe.mode', value: 'live' } }]
  expect(due(d, apply, day('03'), unread)).toEqual([1])
  addSetting(d, { key: 'probe.mode', value: 'live', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-10-03' })
  due(d, apply, day('04'), unread)
  expect(findings(d).map((f) => [f.outcome, f.why])).toEqual([['fixed', "recovered: probe.mode is 'live'"]])
})

test('D5 a finding with no registry entry stays open', () => {
  const d = db()
  addFinding(d, { name: 'gone', state: 'silent', detail: 'no row' }, day('02'))
  due(d, PROBE, day('03'), unread)
  expect(findings(d).map((f) => [f.name, f.closed_at])).toEqual([['gone', null], ['probe', null]])
  expect(ofKind(d, 'drift')).toEqual([])
})

test('D6 due closes nothing before 05:30 or twice a day', () => {
  const d = db()
  expect(due(d, PROBE, day('03'), unread)).toEqual([1])
  event(d, '2026-10-03 12:00:00', 'probe')
  expect(due(d, PROBE, new Date('2026-10-03T12:00:00Z'), unread)).toEqual([])
  expect(due(d, PROBE, new Date('2026-10-04T11:00:00Z'), unread)).toEqual([])
  expect(findings(d)[0]?.closed_at).toBeNull()
  expect(due(d, PROBE, day('04'), unread)).toEqual([])
  expect(findings(d)[0]?.closed_at).toBe('2026-10-04T11:30:00.000Z')
})
