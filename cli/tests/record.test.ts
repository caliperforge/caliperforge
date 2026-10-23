import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { OPERATOR } from '../../sequencer/workspace.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addRule, type Db } from '../../store/index.ts'
import { openRecords, recordsOf } from '../../store/record.ts'
import { setEvidence } from '../../store/targets.ts'
import { adopt } from '../adopt.ts'
import { outside, WINDOW, type Outside, type Pr } from '../gh.ts'
import { fill, render, renderOpen, still } from '../record.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/pay-kit'

const OTHER = 'acme/other'

const TODAY = '2026-09-18'

const url = (repo: string, no: number): string => `https://github.com/${repo}/pull/${String(no)}`

/** The `gh` shapes `cf adopt` reads, for whichever pull request it is handed. */
function canned(args: string[]): unknown {
  if (args[0] === 'pr' && args[1] === 'view') {
    const [no, repo] = [Number(args[2]), String(args[4])]
    return { number: no, url: url(repo, no), state: 'OPEN', title: 't', body: 'b', closingIssuesReferences: [],
      headRefName: `${repo}-${String(no)}`, headRepositoryOwner: { login: 'caliperforge' } }
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
  const { plan, target } = adopt(db, dir, `${REPO}#${String(no)}`, TODAY, canned)
  setEvidence(db, target, `https://github.com/${REPO}/issues/${String(no)}`)
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-25' })
  const approval = gates(db, plan, 'd'.repeat(64))
  pushedRow(db, { plan, step: 7, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64), evidence: url(REPO, no) }, approval)
  return plan
}

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cf-record-'))
}

test('adopted #282, pushed #290 get rows by pr; other repos none', () => {
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
  expect(recordsOf(db, OTHER)).toEqual([])
})

test('last word: newest not by author or bot; empty review: state', () => {
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

test('a second fill rewrites rows in place, showing the new state', () => {
  const db = fresh(schema)
  adopted(db, dir(), REPO, 282)
  fill(db, REPO, (repo, no) => view(repo, no))
  const rows = fill(db, REPO, (repo, no) => view(repo, no, { state: 'MERGED', mergedAt: `${TODAY}T10:00:00Z` }))
  expect(rows.map((r) => [r.pr, r.state, r.merged_at])).toEqual([[282, 'MERGED', `${TODAY}T10:00:00Z`]])
  expect(still(db, REPO)).toBe(0)
})

const SURFPOOL = 'solana-foundation/surfpool'

const NOW = new Date(`${TODAY}T12:00:00Z`)

const hit = (repo: string, no: number, title = 't'): Outside =>
  ({ repository: { nameWithOwner: repo }, number: no, title, createdAt: '2026-09-08T00:00:00Z' })

test('D1: a searched PR with no plan is stored with plan NULL', () => {
  const db = fresh(schema)
  const rows = fill(db, null, (repo, no) => view(repo, no), [hit(SURFPOOL, 827, 'Add a cheatcode')])
  expect(rows.map((r) => [r.repo, r.pr, r.plan])).toEqual([[SURFPOOL, 827, null]])
  expect(renderOpen(rows, NOW)).toBe(`${SURFPOOL}\t#827\tAdd a cheatcode\t10d\t-\n`)
})

test('D2: a searched PR a plan links keeps that plan', () => {
  const db = fresh(schema)
  const plan = adopted(db, dir(), REPO, 282)
  const rows = fill(db, REPO, (repo, no) => view(repo, no), [hit(REPO, 282)])
  expect(rows.map((r) => [r.pr, r.plan])).toEqual([[282, plan]])
})

test('D3: outside searches @me, excluding our own org', () => {
  const asked: string[][] = []
  outside((args) => {
    asked.push(args)
    return []
  })
  const args = asked[0] ?? []
  expect(args.slice(0, 4)).toEqual(['search', 'prs', '--author', '@me'])
  expect(args.slice(-2)).toEqual(['--', '-org:caliperforge'])
  expect(args.join(' ')).not.toContain(OPERATOR)
})

test('D4: a search at the cap throws and no row is written', () => {
  const db = fresh(schema)
  const full = [...Array(WINDOW).keys()].map((i) => hit(SURFPOOL, i + 1))
  expect(() => fill(db, null, (repo, no) => view(repo, no), outside(() => full))).toThrow('cap of 100')
  expect(openRecords(db, null)).toEqual([])
})

test('D5: a stored open PR the search dropped is read till merged', () => {
  const db = fresh(schema)
  fill(db, null, (repo, no) => view(repo, no), [hit(SURFPOOL, 827)])
  const rows = fill(db, null, (repo, no) => view(repo, no, { state: 'MERGED', mergedAt: `${TODAY}T10:00:00Z` }))
  expect(renderOpen(rows, NOW)).toBe('')
  expect(recordsOf(db, SURFPOOL).map((r) => [r.state, r.title])).toEqual([['MERGED', 't']])
})

test('D6: no repo lists open rows across repos; a repo counts them', () => {
  const db = fresh(schema)
  const found = [hit(SURFPOOL, 827), hit(OTHER, 5)]
  const rows = fill(db, null, (repo, no) => view(repo, no), found)
  expect(rows.map((r) => `${r.repo}#${String(r.pr)}`)).toEqual([`${OTHER}#5`, `${SURFPOOL}#827`])
  const one = fresh(schema)
  fill(one, SURFPOOL, (repo, no) => view(repo, no), found)
  expect([still(one, SURFPOOL), recordsOf(one, OTHER)]).toEqual([1, []])
})

test('a repo that is not owner/repo is refused before gh is read', () => {
  const db = fresh(schema)
  const asked: number[] = []
  expect(() => fill(db, 'acme', (repo, no) => {
    asked.push(no)
    return view(repo, no)
  })).toThrow('"acme" is not owner/repo')
  expect(asked).toEqual([])
})
