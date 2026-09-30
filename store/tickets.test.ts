import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import type { Read } from '../cli/gh.ts'
import type { Db } from './index.ts'
import { backfillTickets, HISTORY, recordListing, type Listing } from './tickets.ts'

const SELF = 'caliperforge/caliperforge'

const ATELIER = 'caliperforge/atelier'

const issue = (repo: string, number: number, labels: string[], closedAt: string | null = null,
  stateReason: string | null = null): Listing => ({
  number, title: `issue ${String(number)}`, body: 'the ask', url: `https://github.com/${repo}/issues/${String(number)}`,
  labels: labels.map((name) => ({ name })), createdAt: `2026-01-0${String(number % 9 + 1)}T09:00:00Z`, closedAt, stateReason,
})

const LISTINGS: Record<string, Listing[]> = {
  [`${SELF} open`]: [issue(SELF, 1, ['lane:machine', 'fix'])],
  [`${SELF} closed`]: [issue(SELF, 2, ['lane:machine'], '2026-02-01T09:00:00Z')],
  [`${ATELIER} open`]: [issue(ATELIER, 3, ['lane:atelier'])],
  [`${ATELIER} closed`]: [issue(ATELIER, 4, ['lane:atelier', 'fix'], '2026-02-02T09:00:00Z')],
}

function canned(listings: Record<string, Listing[]>, log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    return listings[`${String(args[3])} ${String(args[5])}`] ?? []
  }
}

const rows = (db: Db): unknown[] =>
  db.prepare('SELECT repo, number, opened_at, closed_at, kind FROM tickets ORDER BY repo, number').all()

const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

const schema = (): Db => fresh(join(import.meta.dirname, '..', 'schema'))

test('lists open and closed issues per repo to the history limit', () => {
  const log: string[] = []
  backfillTickets(schema(), canned(LISTINGS, log))
  expect(log).toEqual([SELF, ATELIER, 'caliperforge/v4-hook-index'].flatMap((repo) => ['open', 'closed'].map((state) =>
    `issue list --repo ${repo} --state ${state} --limit 5000 --json number,title,body,url,labels,createdAt,closedAt,stateReason`)))
})

test('D3 NOT_PLANNED, empty reason as NULL, diagnosis:wrong as 1', () => {
  const db = schema()
  recordListing(db, SELF, [issue(SELF, 5, ['lane:machine'], '2026-02-01T09:00:00Z', 'NOT_PLANNED'),
    issue(SELF, 6, ['lane:machine', 'diagnosis:wrong'], null, '')], false)
  expect(db.prepare('SELECT number, state_reason, diagnosis_wrong FROM tickets ORDER BY number').all()).toEqual([
    { number: 5, state_reason: 'NOT_PLANNED', diagnosis_wrong: 0 },
    { number: 6, state_reason: null, diagnosis_wrong: 1 },
  ])
})

test('fills opened_at, closed_at and kind, idempotently', () => {
  const db = schema()
  expect(backfillTickets(db, canned(LISTINGS))).toBe(4)
  const first = rows(db)
  expect(first).toEqual([
    { repo: ATELIER, number: 3, opened_at: '2026-01-04T09:00:00Z', closed_at: null, kind: 'build' },
    { repo: ATELIER, number: 4, opened_at: '2026-01-05T09:00:00Z', closed_at: '2026-02-02T09:00:00Z', kind: 'fix' },
    { repo: SELF, number: 1, opened_at: '2026-01-02T09:00:00Z', closed_at: null, kind: 'fix' },
    { repo: SELF, number: 2, opened_at: '2026-01-03T09:00:00Z', closed_at: '2026-02-01T09:00:00Z', kind: 'build' },
  ])
  backfillTickets(db, canned(LISTINGS))
  expect(rows(db)).toEqual(first)
})

test('a listing at the history limit throws and writes nothing', () => {
  const db = schema()
  const full = [...Array(HISTORY).keys()].map((n) => issue(ATELIER, n + 10, ['lane:atelier'], '2026-02-02T09:00:00Z'))
  expect(() => backfillTickets(db, canned({ ...LISTINGS, [`${ATELIER} closed`]: full })))
    .toThrow(/caliperforge\/atelier.*closed/)
  expect(count(db, 'tickets')).toBe(0)
})

test('creates no plan', () => {
  const db = schema()
  backfillTickets(db, canned(LISTINGS))
  expect(count(db, 'plans')).toBe(0)
})
