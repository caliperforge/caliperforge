import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { claimed } from '../gh.ts'
import { add } from '../queue.ts'

vi.mock('../gh.ts', () => ({
  issue: () => ({ number: 166, title: 't', body: 'b', state: 'OPEN', assignees: [], comments: [], closedByPullRequestsReferences: [] }),
  lastMerger: () => 'maintainer',
  claimed: vi.fn(() => null),
  implemented: () => null,
}))

const schema = join(import.meta.dirname, '../../schema')
const REPO = 'solana-foundation/pay-kit'
const URL = `https://github.com/${REPO}/issues/166`
const TODAY = '2026-09-23'

function world(): Db {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, ?, 2, 1, ?, 3, 4, 'warm', 'https://github.com/solana-foundation/pay-kit')`).run(REPO, TODAY, TODAY)
  return db
}

const queued = (db: Db): ReturnType<typeof add> =>
  add(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), REPO, URL, 'pr-path', TODAY, { card: '# c\n' })

test('a ready target files one filed event for its plan', () => {
  const db = world()
  const added = queued(db)
  expect(db.prepare('SELECT plan, kind, actor, outcome, message FROM events').all())
    .toEqual([{ plan: added.plan, kind: 'filed', actor: 'cf queue add', outcome: 'pass', message: URL }])
})

test('a refused target writes no event', () => {
  const db = world()
  vi.mocked(claimed).mockReturnValueOnce('assigned to someone')
  expect(queued(db)).toMatchObject({ state: 'refused', plan: null })
  expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 })
})
