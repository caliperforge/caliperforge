import { expect, test } from 'vitest'
import { WINDOW, type Outside, type Pr, type Read } from '../../cli/gh.ts'
import { setting } from '../../store/drift.ts'
import type { Db } from '../../store/index.ts'
import { putRecord, recordsOf } from '../../store/record.ts'
import { drift, due } from '../drift.ts'
import { db, NOW, REGISTRY, unread } from './drifting.ts'

const RECORDS = [{ name: 'records', table: 'records', column: 'read_at', gap: '1d' }]
const OUTSIDE = REGISTRY.filter((e) => e.name === 'outside_records')
const PR = 'https://github.com/acme/widget/pull/7'
const AT = new Date('2026-10-03T11:30:00Z')
const LATER = new Date('2026-10-03T12:00:00Z')

function ours(d: Db): Db {
  d.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', '2026-09-01', 1, 1, '2026-08-01', 0, 0, 'cold', 'https://github.com/acme/widget/pulse');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 7, 'maintainer', 'queued', '2026-09-01', '${PR}');
    UPDATE plans SET target_id = 1`)
  return d
}

function reader(asked: string[]): (repo: string, no: number) => Pr {
  return (repo, no) => {
    asked.push(`${repo}#${String(no)}`)
    return { number: no, url: `https://github.com/${repo}/pull/${String(no)}`, state: 'OPEN', mergedAt: null, mergedBy: null,
      reviewDecision: null, comments: [], reviews: [], author: { login: 'caliperforge' }, statusCheckRollup: null }
  }
}

const hit = (no: number): Outside => ({ repository: { nameWithOwner: 'acme/widget' }, number: no, title: 't', createdAt: '2026-09-08T00:00:00Z' })

function search(asked: string[][], nos: number[]): Read {
  return (args) => {
    asked.push(args)
    return nos.map(hit)
  }
}

const unsearched: Read = () => { throw new Error('search') }

const stored = (d: Db): [number, number | null][] => recordsOf(d, 'acme/widget').map((r) => [r.pr, r.plan])

test('D1-D3: 05:30 stores each hit once, plan or none', () => {
  const d = ours(db())
  const asked: string[] = []
  const searched: string[][] = []
  expect(due(d, RECORDS, AT, reader(asked), search(searched, [7, 9]))).toEqual([])
  expect(searched).toHaveLength(1)
  expect(asked).toEqual(['acme/widget#7', 'acme/widget#9'])
  expect(stored(d)).toEqual([[7, 1], [9, null]])
  expect(due(d, RECORDS, LATER, unread, unsearched)).toEqual([])
})

test('D2: before 05:30 or again that day, nothing is read or filed', () => {
  const d = ours(db())
  expect(due(d, RECORDS, new Date('2026-10-03T11:29:00Z'), unread, unsearched)).toEqual([])
  d.exec("UPDATE settings SET value = '2026-10-03' WHERE key = 'drift.at'")
  expect(due(d, RECORDS, LATER, unread, unsearched)).toEqual([])
})

test('D4: a failed read throws, drift.at set, no retry that day', () => {
  const d = ours(db())
  const searched: string[][] = []
  expect(() => due(d, RECORDS, AT, unread, search(searched, [7]))).toThrow('read')
  expect(setting(d, 'drift.at')).toBe('2026-10-03')
  const asked: string[] = []
  expect(due(d, RECORDS, LATER, reader(asked), search(searched, [7]))).toEqual([])
  expect([asked, searched.length]).toEqual([[], 1])
})

test('D4: a search at the cap throws and writes no row', () => {
  const d = ours(db())
  const asked: string[] = []
  const full = [...Array(WINDOW).keys()].map((i) => hit(i + 1))
  expect(() => due(d, RECORDS, AT, reader(asked), () => full)).toThrow('cap of 100')
  expect([asked, stored(d)]).toEqual([[], []])
})

test('D5: outside_records is stale a day past a plan-less read', () => {
  const d = ours(db())
  const row = (pr: number, plan: number | null, read_at: string): void => {
    putRecord(d, { repo: 'acme/widget', pr, plan, url: `https://github.com/acme/widget/pull/${String(pr)}`, state: 'OPEN',
      merged_at: null, word_by: null, word_at: null, word: null, read_at, title: null, opened_at: null })
  }
  row(7, 1, NOW.toISOString())
  row(9, null, '2026-10-02T09:00:00.000Z')
  expect(drift(d, OUTSIDE, NOW).map((f) => [f.name, f.state])).toEqual([['outside_records', 'stale']])
  row(9, null, '2026-10-02T11:00:00.000Z')
  expect(drift(d, OUTSIDE, NOW)).toEqual([])
})
