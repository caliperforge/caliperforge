import { expect, test } from 'vitest'
import { capped, setting } from '../../store/drift.ts'
import { due, filed } from '../drift.ts'
import { SELF } from '../workspace.ts'
import { db, NOW, unread } from './drifting.ts'

test('fileOnce', () => {
  const d = db()
  const sent: [string, string, string, string[]][] = []
  const wire = { file: (repo: string, title: string, body: string, labels: string[]): string => {
    sent.push([repo, title, body, labels])
    return `u${String(sent.length)}`
  } }
  d.exec(`INSERT INTO tickets (repo, number, title, lane) VALUES ('${SELF}', 1, 'Drift: hq is off', 'machine');
    INSERT INTO tickets (repo, number, title, lane, closed_at) VALUES ('${SELF}', 2, 'Drift: desk is off', 'machine', '2026-10-01')`)
  const rows = [{ name: 'hq', state: 'off', detail: 'd' }, { name: 'desk', state: 'off', detail: 'd' }] as const
  expect(filed(d, [...rows], wire, new Date('2026-10-09T10:00:00Z'))).toEqual(['u1'])
  expect(sent).toEqual([[SELF, 'Drift: desk is off', '**What:** desk is off: d\n' +
    '**Why:** rules/registry.yaml lists desk as a mechanism that runs\n**When it ends:** drift no longer reports desk\n',
  ['lane:machine', 'P1', 'drift']]])
})

function titled(sent: string[][]): { file: (repo: string, title: string) => string } {
  return { file: (repo, title) => String(sent.push([repo, title])) }
}

const off = (name: string): { name: string; state: 'off'; detail: string } => ({ name, state: 'off', detail: 'd' })
const sends = (names: string[]): string[][] => names.map((n) => [SELF, `Drift: ${n} is off`])

test('capThree', () => {
  const d = db()
  d.exec(`INSERT INTO tickets (repo, number, title, lane) VALUES ('${SELF}', 1, 'Drift: a is off', 'machine')`)
  const sent: string[][] = []
  expect(filed(d, ['a', 'b', 'c', 'd', 'e', 'f'].map(off), titled(sent), NOW)).toEqual(['1', '2', '3'])
  expect(sent).toEqual(sends(['b', 'c', 'd']))
  expect(capped(d, NOW)).toEqual(['Drift: e is off', 'Drift: f is off'])
})

test('closedNotRefiled', () => {
  const d = db()
  d.exec(`INSERT INTO tickets (repo, number, title, lane, closed_at) VALUES ('${SELF}', 1, 'Drift: a is off', 'machine', '2026-10-02T10:00:00Z'),
    ('${SELF}', 2, 'Drift: b is off', 'machine', '2026-09-25T10:00:00Z')`)
  const sent: string[][] = []
  expect(filed(d, ['a', 'b'].map(off), titled(sent), NOW)).toEqual(['1'])
  expect(sent).toEqual(sends(['b']))
})

test('dailyOnce', () => {
  const d = db()
  let sent = 0
  const wire = { file: (): string => `u${String(++sent)}` }
  const desk = [{ name: 'desk', switch: { key: 'comms.site_dir' } }]
  expect(due(d, desk, new Date('2026-10-03T11:29:00Z'), wire, unread)).toEqual([])
  expect(due(d, desk, new Date('2026-10-03T11:30:00Z'), wire, unread)).toEqual(['u1'])
  expect(due(d, desk, new Date('2026-10-04T05:00:00Z'), wire, unread)).toEqual([])
  expect(due(d, desk, new Date('2026-10-04T11:30:00Z'), wire, unread)).toEqual(['u2'])
  const e = db()
  expect(() => due(e, desk, new Date('2026-10-03T11:30:00Z'), { file: () => { throw new Error('gh') } }, unread)).toThrow('gh')
  expect(setting(e, 'drift.at')).toBe('2026-10-03')
})
