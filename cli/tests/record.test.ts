import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Db } from '../../store/index.ts'
import { adopt } from '../adopt.ts'
import type { Pr } from '../gh.ts'
import { fill, render, still } from '../record.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/pay-kit'

const OTHER = 'acme/other'

const TODAY = '2026-09-18'

const url = (repo: string, no: number): string => `https://github.com/${repo}/pull/${String(no)}`

/** The `gh` shapes `cf adopt` reads, for whichever pull request it is handed. */
function canned(args: string[]): unknown {
  if (args[0] === 'pr' && args[1] === 'view') {
    const [no, repo] = [Number(args[2]), String(args[4])]
    return { number: no, url: url(repo, no), state: 'OPEN', title: 't', body: 'b', closingIssuesReferences: [] }
  }
  if (args[0] === 'search') return [{ repository: { nameWithOwner: OTHER } }]
  if (args.includes('createdAt,headRepositoryOwner')) {
    return [{ createdAt: `${TODAY}T00:00:00Z`, headRepositoryOwner: { login: 'caliperforge' } }]
  }
  return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: `${TODAY}T00:00:00Z` }]
}

const view = (repo: string, no: number, over: Partial<Pr> = {}): Pr => ({
  number: no,
  url: url(repo, no),
  state: 'OPEN',
  mergedAt: null,
  mergedBy: null,
  reviewDecision: null,
  comments: [],
  reviews: [],
  author: { login: 'caliperforge' },
  statusCheckRollup: null,
  ...over,
})

const comment = (author: string, body: string, at: string): Pr['comments'][number] =>
  ({ id: `c-${at}`, author: { login: author }, body, createdAt: `${TODAY}T${at}:00Z` })

const review = (author: string, body: string, state: string, at: string): Pr['reviews'][number] =>
  ({ id: `r-${at}`, author: { login: author }, body, state, submittedAt: `${TODAY}T${at}:00Z` })

function adopted(db: Db, dir: string, repo: string, no: number): number {
  return adopt(db, dir, `${repo}#${String(no)}`, TODAY, canned).plan
}

/** A v2 plan: its target names the issue, and its pushed deliverable names the pull request. */
function pushed(db: Db, dir: string, no: number): number {
  const plan = adopted(db, dir, REPO, no)
  db.prepare('UPDATE targets SET evidence = ? WHERE issue_no = ?').run(`https://github.com/${REPO}/issues/${String(no)}`, no)
  db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
    VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', ?, '2026-09-25')`).run('0'.repeat(64))
  const approval = db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('plan', ?, ?, 'gates', 'approved', '2026-09-25T00:00:00.000Z') RETURNING id`).get(plan, 'd'.repeat(64)) as { id: number }
  db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere,
    fork_ci_green, bot_clean, target_warm, approval_id, evidence)
    VALUES (?, 7, 'typescript_specialist', ?, 'pushed', 1, 1, 1, 1, 1, ?, ?)`).run(plan, 'd'.repeat(64), approval.id, url(REPO, no))
  return plan
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cf-record-'))
}

test('D1: the adopted #282 and a pushed #290 get rows in pr order; a pull request in another repo gets none', () => {
  const db = fresh(schema)
  const d = dir()
  const first = adopted(db, d, REPO, 282)
  const second = pushed(db, d, 290)
  adopted(db, d, OTHER, 5)
  const asked: string[] = []
  const rows = fill(db, REPO, (repo, no) => {
    asked.push(`${repo}#${String(no)}`)
    return view(repo, no)
  })
  expect(asked).toEqual([`${REPO}#282`, `${REPO}#290`])
  expect(render(REPO, rows, still(db, REPO))).toBe(`${REPO}\topen 2\n`
    + `#282\tOPEN\tplan ${String(first)}\t-\t${url(REPO, 282)}\n`
    + `#290\tOPEN\tplan ${String(second)}\t-\t${url(REPO, 290)}\n`)
  expect(db.prepare('SELECT count(*) AS n FROM records WHERE repo = ?').get(OTHER)).toEqual({ n: 0 })
})

test('D2: the last word skips the author and bots and takes the newest of the rest; an empty review gives its state', () => {
  const db = fresh(schema)
  adopted(db, dir(), REPO, 282)
  const said = (over: Partial<Pr>): string => render(REPO, fill(db, REPO, (repo, no) => view(repo, no, over)), 0).split('\n')[1] ?? ''
  expect(said({
    comments: [comment('ludo', `${'x'.repeat(120)}\nsecond line`, '10:00'), comment('caliperforge', 'mine', '12:00'),
      comment('greptile-apps[bot]', 'Confidence Score: 4/5', '13:00')],
    reviews: [review('dev', 'older', 'COMMENTED', '09:00')],
  })).toBe(`#282\tOPEN\tplan 1\tludo: ${'x'.repeat(100)}\t${url(REPO, 282)}`)
  expect(said({ comments: [comment('ludo', 'nit', '10:00')], reviews: [review('dev', '  ', 'CHANGES_REQUESTED', '11:00')] }))
    .toBe(`#282\tOPEN\tplan 1\tdev: CHANGES_REQUESTED\t${url(REPO, 282)}`)
  expect(said({ comments: [comment('caliperforge', 'mine', '10:00')], reviews: [review('coderabbitai[bot]', 'ok', 'APPROVED', '11:00')] }))
    .toBe(`#282\tOPEN\tplan 1\t-\t${url(REPO, 282)}`)
})

test('D3: still counts only open, unmerged rows, per repo', () => {
  const db = fresh(schema)
  const d = dir()
  for (const no of [1, 2, 3, 4]) adopted(db, d, REPO, no)
  adopted(db, d, OTHER, 1)
  const states: Record<number, Partial<Pr>> = {
    3: { state: 'MERGED', mergedAt: `${TODAY}T10:00:00Z` },
    4: { state: 'CLOSED' },
  }
  fill(db, REPO, (repo, no) => view(repo, no, states[no]))
  fill(db, OTHER, (repo, no) => view(repo, no))
  expect([still(db, REPO), still(db, OTHER)]).toEqual([2, 1])
})

test('D4: a second fill rewrites each row in place and shows the new state', () => {
  const db = fresh(schema)
  adopted(db, dir(), REPO, 282)
  fill(db, REPO, (repo, no) => view(repo, no))
  const rows = fill(db, REPO, (repo, no) => view(repo, no, { state: 'MERGED', mergedAt: `${TODAY}T10:00:00Z` }))
  expect(rows.map((r) => [r.pr, r.state, r.merged_at])).toEqual([[282, 'MERGED', `${TODAY}T10:00:00Z`]])
  expect(still(db, REPO)).toBe(0)
})

test('D5: a repo that is not owner/repo is refused before gh is read', () => {
  const db = fresh(schema)
  const asked: number[] = []
  expect(() => fill(db, 'acme', (repo, no) => {
    asked.push(no)
    return view(repo, no)
  })).toThrow('"acme" is not owner/repo')
  expect(asked).toEqual([])
})
