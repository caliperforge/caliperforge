import { expect, test } from 'vitest'
import type { Pr } from '../../cli/gh.ts'
import { setting } from '../../store/drift.ts'
import type { Db } from '../../store/index.ts'
import { due } from '../drift.ts'
import { db, unread } from './drifting.ts'

const RECORDS = [{ name: 'records', table: 'records', column: 'read_at', gap: '1d' }]
const PR = 'https://github.com/acme/widget/pull/7'
const nothing = { file: (): string => { throw new Error('filed') } }

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
    return { number: no, url: PR, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null, comments: [],
      reviews: [], author: { login: 'caliperforge' }, statusCheckRollup: null }
  }
}

test('D1: the daily check reads our PRs into records first', () => {
  const d = ours(db())
  const asked: string[] = []
  expect(due(d, RECORDS, new Date('2026-10-03T11:30:00Z'), nothing, reader(asked))).toEqual([])
  expect(asked).toEqual(['acme/widget#7'])
  expect(d.prepare('SELECT repo, pr, plan FROM records').all()).toEqual([{ repo: 'acme/widget', pr: 7, plan: 1 }])
})

test('D2: before 05:30 or again that day, nothing is read or filed', () => {
  const d = ours(db())
  expect(due(d, RECORDS, new Date('2026-10-03T11:29:00Z'), nothing, unread)).toEqual([])
  d.exec("UPDATE settings SET value = '2026-10-03' WHERE key = 'drift.at'")
  expect(due(d, RECORDS, new Date('2026-10-03T12:00:00Z'), nothing, unread)).toEqual([])
})

test('D3: a failed read throws, drift.at set, no retry that day', () => {
  const d = ours(db())
  expect(() => due(d, RECORDS, new Date('2026-10-03T11:30:00Z'), nothing, unread)).toThrow('read')
  expect(setting(d, 'drift.at')).toBe('2026-10-03')
  const asked: string[] = []
  expect(due(d, RECORDS, new Date('2026-10-03T12:00:00Z'), nothing, reader(asked))).toEqual([])
  expect(asked).toEqual([])
})
