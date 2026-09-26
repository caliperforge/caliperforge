import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { FORK } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import type { Read } from '../gh.ts'
import { render, scan } from '../scan.ts'

const schema = join(import.meta.dirname, '../../schema')
const REPO = 'acme/widget'
const TODAY = '2026-09-26'

interface Canned { issues: unknown[]; prs?: unknown[]; merger?: string | null }

function canned(rows: Canned, log: string[] = []): Read {
  return (args) => {
    log.push(args.join(' '))
    const fields = args.at(-1)
    if (args[0] === 'search') return []
    if (fields === 'mergedBy') return rows.merger === null ? [] : [{ mergedBy: { login: 'maintainer' } }]
    if (fields === 'author,mergedBy,mergedAt') {
      return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: '2026-09-20T00:00:00Z' }]
    }
    if (fields === 'createdAt,headRepositoryOwner') return []
    if (fields === 'number,body,url,createdAt,updatedAt') return rows.issues
    return rows.prs ?? []
  }
}

const issue = (no: number, body = 'one'): unknown => ({ number: no, body, url: `https://github.com/${REPO}/issues/${String(no)}`,
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' })

const pr = (no: number, body: string, isDraft: boolean, owner: string): unknown =>
  ({ number: no, title: 'fix', body, isDraft, headRepositoryOwner: { login: owner } })

function world(): Db {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, '2026-09-01', 1, 1, '2026-08-01', 0, 0, 'cold', 'https://github.com/acme/widget/pulse')`).run(REPO)
  return db
}

const row = (db: Db, no: number): Record<string, unknown> =>
  db.prepare('SELECT * FROM targets WHERE repo = ? AND issue_no = ?').get(REPO, no) as Record<string, unknown>

const count = (db: Db, table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test('D1: each open issue becomes a ready target with its evidence, and no plan is filed', () => {
  const db = world()
  const plans = count(db, 'plans')
  const got = scan(db, REPO, TODAY, canned({
    issues: [issue(1, 'a\n\nb\n  \nc'), issue(2)],
    prs: [pr(9, 'also #2', false, 'other'), pr(7, 'fixes #2', true, 'someone')],
  }))
  expect(got).toEqual({ targets: [expect.any(Number), expect.any(Number)], why: null })
  const today = (db.prepare('SELECT id FROM accounts WHERE repo = ? AND measured_at = ?').get(REPO, TODAY) as { id: number }).id
  expect(row(db, 1)).toMatchObject({ state: 'ready', named_merger: 'maintainer', account_id: today, evidence_measured_at: TODAY,
    issue_opened_at: '2026-09-01', issue_active_at: '2026-09-20', size_lines: 3, open_pr: null, open_pr_draft: null })
  expect(row(db, 2)).toMatchObject({ state: 'ready', named_merger: 'maintainer', account_id: today, size_lines: 1,
    open_pr: 7, open_pr_draft: 1 })
  expect(count(db, 'plans')).toBe(plans)
  expect(render(db, row(db, 2).id as number)).toContain('pr #7 draft')
})

test('D2: two of ours open and unmerged refuse the scan before any read; one does not', () => {
  const db = world()
  const pipe = Number(db.prepare(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('scan', 1, '00:00', '23:59', 1)`).run().lastInsertRowid)
  const target = Number(db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, ?, 50, 'maintainer', 'queued', '2026-09-01', 'https://github.com/acme/widget/issues/50')`).run(REPO).lastInsertRowid)
  const plan = Number(db.prepare(`INSERT INTO plans (pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (?, ?, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 0, 0)`).run(pipe, target).lastInsertRowid)
  for (const no of [3, 4]) {
    db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, read_at)
      VALUES (?, ?, ?, ?, 'OPEN', NULL, '2026-09-25T00:00:00Z')`).run(REPO, no, plan, `https://github.com/${REPO}/pull/${String(no)}`)
  }
  const log: string[] = []
  const got = scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2)] }, log))
  expect(got.targets).toEqual([])
  expect(got.why).toMatch(/2 pull requests of ours open and unmerged/)
  expect(log).toEqual([])
  expect([count(db, 'targets'), count(db, 'accounts')]).toEqual([1, 1])
  db.prepare('DELETE FROM records WHERE pr = 4').run()
  expect(scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2)] })).targets).toHaveLength(2)
})

test('D3: a refused or queued target keeps every column', () => {
  const db = world()
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence,
    ineligible_ruling_id, issue_opened_at, issue_active_at, open_pr, open_pr_draft, size_lines)
    VALUES (1, ?, 1, 'old', 'refused', '2026-09-01', 'https://github.com/acme/widget/pull/3',
      (SELECT min(id) FROM rulings), '2026-01-01', '2026-01-02', 4, 0, 9)`).run(REPO)
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, ?, 2, 'old', 'queued', '2026-09-01', 'https://github.com/acme/widget/issues/2')`).run(REPO)
  const refused = row(db, 1)
  const got = scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2), issue(3)] }))
  expect(got.targets).toHaveLength(1)
  expect(row(db, 1)).toEqual(refused)
  expect(row(db, 2)).toMatchObject({ state: 'queued', named_merger: 'old' })
  expect(db.prepare('SELECT count(*) AS n FROM targets GROUP BY repo, issue_no, part HAVING n > 1').all()).toEqual([])
})

test('D4: a repo with no named merger gets no targets', () => {
  const db = world()
  expect(scan(db, REPO, TODAY, canned({ issues: [issue(1)], merger: null })))
    .toEqual({ targets: [], why: `${REPO} has no named merger` })
  expect(count(db, 'targets')).toBe(0)
})

test('D5: a pull request from our fork, or one naming #12, is not an open pr on #1', () => {
  const db = world()
  scan(db, REPO, TODAY, canned({ issues: [issue(1)], prs: [pr(5, 'closes #1', false, FORK), pr(6, 'see #12', false, 'someone')] }))
  expect(row(db, 1)).toMatchObject({ state: 'ready', open_pr: null, open_pr_draft: null })
})

test('D6: the new columns refuse a bad date, a draft flag of 2 and a negative size', () => {
  const db = world()
  const insert = (column: string, value: unknown): void => {
    db.prepare(`INSERT INTO targets (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence, ${column})
      VALUES (1, ?, 1, 'm', 'ready', '2026-09-01', 'https://github.com/acme/widget/issues/1', ?)`).run(REPO, value)
  }
  expect(() => { insert('issue_opened_at', '2026-09-01T10:00:00Z') }).toThrow(/CHECK/)
  expect(() => { insert('open_pr_draft', 2) }).toThrow(/CHECK/)
  expect(() => { insert('size_lines', -1) }).toThrow(/CHECK/)
})
