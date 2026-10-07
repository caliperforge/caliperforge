import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { FORK } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import { addPipe, addPlan, pipeNamed, planRows } from '../../store/plans.ts'
import { addRecord, dropRecord } from '../../store/record.ts'
import { accountRows, addAccount, addTarget, putTarget, targetRows } from '../../store/targets.ts'
import type { Read } from '../gh.ts'
import { account, refuseTarget } from '../queue.ts'
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
  addAccount(db, { id: 1, repo: REPO, measured_at: '2026-09-01', maintainers: 1, doors: 1, last_outsider_merge: '2026-08-01',
    open_pr_age_p50_days: 0, cross_repo_activity: 0, pulse: 'cold', evidence: 'https://github.com/acme/widget/pulse' })
  return db
}

const row = (db: Db, no: number): Record<string, unknown> | undefined =>
  targetRows(db).find((t) => t.repo === REPO && t.issue_no === no)

const ROWS = { accounts: accountRows, plans: planRows, targets: targetRows }

const count = (db: Db, table: keyof typeof ROWS): number => ROWS[table](db).length

const TARGET = { account_id: 1, repo: REPO, evidence_measured_at: '2026-09-01' }

test('open issues become ready targets with evidence, no plan', () => {
  const db = world()
  const plans = count(db, 'plans')
  const got = scan(db, REPO, TODAY, canned({
    issues: [issue(1, 'a\n\nb\n  \nc'), issue(2)],
    prs: [pr(9, 'also #2', false, 'other'), pr(7, 'fixes #2', true, 'someone')],
  }))
  expect(got).toEqual({ targets: [expect.any(Number), expect.any(Number)], why: null })
  const today = account(db, REPO, TODAY).id
  expect(row(db, 1)).toMatchObject({ state: 'ready', named_merger: 'maintainer', account_id: today, evidence_measured_at: TODAY,
    issue_opened_at: '2026-09-01', issue_active_at: '2026-09-20', size_lines: 3, open_pr: null, open_pr_draft: null })
  expect(row(db, 2)).toMatchObject({ state: 'ready', named_merger: 'maintainer', account_id: today, size_lines: 1,
    open_pr: 7, open_pr_draft: 1 })
  expect(count(db, 'plans')).toBe(plans)
  expect(render(db, row(db, 2)?.id as number)).toContain('pr #7 draft')
})

test('two of ours open refuse scan before any read; one does not', () => {
  const db = world()
  addPipe(db, { name: 'scan', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  const pipe = Number(pipeNamed(db, 'scan')?.id)
  const target = addTarget(db, { ...TARGET, issue_no: 50, named_merger: 'maintainer', state: 'queued',
    evidence: 'https://github.com/acme/widget/issues/50' })
  const plan = addPlan(db, { pipe_id: pipe, target_id: target, template: 'pr_path', state: 'queued', queued_at: '2026-09-20T00:00:00.000Z',
    lane: null, seat: null, origin: null, step: 0 })
  for (const no of [3, 4]) {
    addRecord(db, { repo: REPO, pr: no, plan, url: `https://github.com/${REPO}/pull/${String(no)}`, state: 'OPEN', merged_at: null,
      read_at: '2026-09-25T00:00:00Z' })
  }
  const log: string[] = []
  const got = scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2)] }, log))
  expect(got.targets).toEqual([])
  expect(got.why).toMatch(/2 pull requests of ours open and unmerged/)
  expect(log).toEqual([])
  expect([count(db, 'targets'), count(db, 'accounts')]).toEqual([1, 1])
  dropRecord(db, REPO, 4)
  expect(scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2)] })).targets).toHaveLength(2)
})

test('D3: a refused or queued target keeps every column', () => {
  const db = world()
  putTarget(db, { ...TARGET, issue_no: 1, named_merger: 'old', state: 'refused', evidence: 'https://github.com/acme/widget/pull/3',
    ineligible_ruling_id: 1, issue_opened_at: '2026-01-01', issue_active_at: '2026-01-02', open_pr: 4, open_pr_draft: 0, size_lines: 9 })
  addTarget(db, { ...TARGET, issue_no: 2, named_merger: 'old', state: 'queued', evidence: 'https://github.com/acme/widget/issues/2' })
  const refused = row(db, 1)
  const got = scan(db, REPO, TODAY, canned({ issues: [issue(1), issue(2), issue(3)] }))
  expect(got.targets).toHaveLength(1)
  expect(row(db, 1)).toEqual(refused)
  expect(row(db, 2)).toMatchObject({ state: 'queued', named_merger: 'old' })
  const keys = targetRows(db).map((t) => `${String(t.repo)}#${String(t.issue_no)}#${String(t.part)}`)
  expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
})

test('a rescan leaves a CEO-refused target alone and omits it', () => {
  const db = world()
  const [id] = scan(db, REPO, TODAY, canned({ issues: [issue(1)] })).targets
  refuseTarget(db, Number(id), 'not.ours', 'coo')
  const refused = row(db, 1)
  expect(scan(db, REPO, TODAY, canned({ issues: [issue(1, 'grown\nlonger')] })).targets).toEqual([])
  expect(row(db, 1)).toEqual(refused)
})

test('D4: a repo with no named merger gets no targets', () => {
  const db = world()
  expect(scan(db, REPO, TODAY, canned({ issues: [issue(1)], merger: null })))
    .toEqual({ targets: [], why: `${REPO} has no named merger` })
  expect(count(db, 'targets')).toBe(0)
})

test('a PR from our fork, or naming #12, is not an open pr on #1', () => {
  const db = world()
  scan(db, REPO, TODAY, canned({ issues: [issue(1)], prs: [pr(5, 'closes #1', false, FORK), pr(6, 'see #12', false, 'someone')] }))
  expect(row(db, 1)).toMatchObject({ state: 'ready', open_pr: null, open_pr_draft: null })
})

test('new columns refuse bad date, draft flag 2 and negative size', () => {
  const db = world()
  const insert = (column: string, value: unknown): void => {
    putTarget(db, { ...TARGET, issue_no: 1, named_merger: 'm', state: 'ready', evidence: 'https://github.com/acme/widget/issues/1',
      [column]: value })
  }
  expect(() => { insert('issue_opened_at', '2026-09-01T10:00:00Z') }).toThrow(/CHECK/)
  expect(() => { insert('open_pr_draft', 2) }).toThrow(/CHECK/)
  expect(() => { insert('size_lines', -1) }).toThrow(/CHECK/)
})
