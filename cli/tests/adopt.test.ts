import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { capture } from '../../sequencer/capture.ts'
import { started } from '../../sequencer/signals.ts'
import { SignalRow } from '../../store/signals.ts'
import type { Db } from '../../store/index.ts'
import { adopt, render } from '../adopt.ts'
import type { Pr } from '../gh.ts'
import type { Read } from '../gh.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/pay-kit'

const URL = `https://github.com/${REPO}/pull/282`

const TODAY = '2026-09-18'

/** The `gh` shapes adopt reads: the pull request itself, and the three `cf measure` takes its pulse from. */
function canned(log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    if (args[0] === 'pr' && args[1] === 'view') return { number: 282, url: URL, state: 'OPEN' }
    if (args[0] === 'search') return [{ repository: { nameWithOwner: 'acme/other' } }]
    if (args.includes('createdAt,headRepositoryOwner')) {
      return [{ createdAt: `${TODAY}T00:00:00Z`, headRepositoryOwner: { login: 'caliperforge' } }]
    }
    return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: `${TODAY}T00:00:00Z` }]
  }
}

/** The pull request `capture()` polls once the row exists: one maintainer comment and one red check. */
const view = (): Pr => ({
  number: 282,
  url: URL,
  state: 'OPEN',
  mergedAt: null,
  mergedBy: null,
  comments: [{ id: 'c1', author: { login: 'ludo' }, body: 'one nit here', createdAt: '2026-09-18T10:00:00Z' }],
  reviews: [],
  statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
})

function rows(db: Db, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

test('cf adopt files one plan at the pushed step, with the targets and accounts rows it needs', () => {
  const db = fresh(schema)
  const log: string[] = []
  const row = adopt(db, `${REPO}#282`, TODAY, canned(log))
  expect(row).toMatchObject({ repo: REPO, pr: 282, url: URL, fresh: true })
  expect(rows(db, 'SELECT repo, measured_at FROM accounts')).toEqual([{ repo: REPO, measured_at: TODAY }])
  expect(rows(db, 'SELECT repo, issue_no, state, evidence FROM targets'))
    .toEqual([{ repo: REPO, issue_no: 282, state: 'queued', evidence: URL }])
  expect(rows(db, 'SELECT id, template, state, step, target_id FROM plans'))
    .toEqual([{ id: row.plan, template: 'pr_path', state: 'done', step: 8, target_id: row.target }])
  expect(log[0]).toBe('pr view 282 --repo solana-foundation/pay-kit --json number,url,state')
})

test('nothing is pushed: the adopted row carries no deliverable, no proof and no approval', () => {
  const db = fresh(schema)
  adopt(db, `${REPO}#282`, TODAY, canned())
  expect(rows(db, 'SELECT id FROM deliverables')).toEqual([])
  expect(rows(db, 'SELECT id FROM approvals')).toEqual([])
})

test('adopting the same pull request twice is one plan row, and the second call returns the first', () => {
  const db = fresh(schema)
  const first = adopt(db, `${REPO}#282`, TODAY, canned())
  const again = adopt(db, `${REPO}#282`, TODAY, canned())
  expect(again.plan).toBe(first.plan)
  expect(again.target).toBe(first.target)
  expect(again.fresh).toBe(false)
  expect(rows(db, 'SELECT count(*) AS n FROM plans')).toEqual([{ n: 1 }])
  expect(rows(db, 'SELECT count(*) AS n FROM targets')).toEqual([{ n: 1 }])
  expect(render(again)).toContain('already watched')
})

test('capture reads an adopted pull request like any v2 pushed one, and replays nothing', () => {
  const db = fresh(schema)
  const row = adopt(db, `${REPO}#282`, TODAY, canned())
  expect(capture(db, () => view()).map((s) => [s.kind, s.author, s.plan]))
    .toEqual([['comment', 'ludo', row.plan], ['ci_red', 'ci', row.plan]])
  expect(rows(db, 'SELECT repo, pr, kind, author FROM signals ORDER BY id')).toEqual([
    { repo: REPO, pr: 282, kind: 'comment', author: 'ludo' },
    { repo: REPO, pr: 282, kind: 'ci_red', author: 'ci' },
  ])
  expect(capture(db, () => view()).filter((s) => s.kind === 'comment')).toEqual([])
})

test("a maintainer's comment on an adopted pull request puts its plan back on the review step", () => {
  const db = fresh(schema)
  const row = adopt(db, `${REPO}#282`, TODAY, canned())
  const comment = capture(db, () => view())[0]
  expect(comment).toBeDefined()
  expect(started(db, SignalRow.parse(comment))).toMatchObject({ template: 'pr_path', plan: row.plan, step: 4 })
  expect(db.prepare('SELECT step, state FROM plans WHERE id = ?').get(row.plan))
    .toEqual({ step: 4, state: 'running' })
})
