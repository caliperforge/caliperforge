import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { capture } from '../../sequencer/capture.ts'
import { opened } from '../../sequencer/push.ts'
import { started, words } from '../../sequencer/signals.ts'
import { drop, get, maybe, PR_BRANCH } from '../../sequencer/workspace.ts'
import { decide } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { SignalRow } from '../../store/signals.ts'
import { addRule, type Db } from '../../store/index.ts'
import { adopt, render } from '../adopt.ts'
import type { Pr, Read } from '../gh.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/pay-kit'

const URL = `https://github.com/${REPO}/pull/282`

const TODAY = '2026-09-18'

const BRANCH = 'pay-kit-270-a1'

const ADOPTED = '2026-09-18T09:09:00.000Z'

/** The `gh` shapes adopt reads: the pull request, the issue it closes, and the three `cf measure` takes its pulse from. */
function canned(log: string[] = [], linked: number | null = 270, owner = 'caliperforge'): Read {
  return (args) => {
    log.push(args.join(' '))
    if (args[0] === 'pr' && args[1] === 'view') {
      return { number: 282, url: URL, state: 'OPEN', title: 'add the pay button', body: 'the button, wired to the kit',
        closingIssuesReferences: linked === null ? [] : [{ number: linked }], headRefName: BRANCH, headRepositoryOwner: { login: owner } }
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return { number: 270, title: 'no pay button', body: 'the kit ships without one' }
    }
    if (args[0] === 'search') return [{ repository: { nameWithOwner: 'acme/other' } }]
    if (args.includes('createdAt,headRepositoryOwner')) {
      return [{ createdAt: `${TODAY}T00:00:00Z`, headRepositoryOwner: { login: 'caliperforge' } }]
    }
    return [{ author: { login: 'outsider' }, mergedBy: { login: 'maintainer' }, mergedAt: `${TODAY}T00:00:00Z` }]
  }
}

/** The pull request `capture()` polls once the row exists: one maintainer comment and one red check. */
const view = (over: Partial<Pr> = {}): Pr => ({
  number: 282,
  url: URL,
  state: 'OPEN',
  mergedAt: null,
  mergedBy: null,
  reviewDecision: null,
  comments: [{ id: 'c1', author: { login: 'ludo' }, body: 'one nit here', createdAt: '2026-09-18T10:00:00Z' }],
  reviews: [],
  statusCheckRollup: [{ name: 'build', conclusion: 'FAILURE' }],
  ...over,
})

const comment = (id: string, author: string, at: string): Pr['comments'][number] =>
  ({ id, author: { login: author }, body: 'said before the row existed', createdAt: at })

function rows(db: Db, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

function root(): string {
  return mkdtempSync(join(tmpdir(), 'cf-adopt-'))
}

/** The plan as the live board carries it: adopted at a known minute, which is what a signal's age is read against. */
function adopted(db: Db, dir: string): number {
  const row = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  db.prepare('UPDATE plans SET queued_at = ? WHERE id = ?').run(ADOPTED, row.plan)
  return row.plan
}

test('cf adopt files one pushed plan with target and account rows', () => {
  const db = fresh(schema)
  const log: string[] = []
  const row = adopt(db, root(), `${REPO}#282`, TODAY, canned(log))
  expect(row).toMatchObject({ repo: REPO, pr: 282, url: URL, fresh: true })
  expect(rows(db, 'SELECT repo, measured_at FROM accounts')).toEqual([{ repo: REPO, measured_at: TODAY }])
  expect(rows(db, 'SELECT repo, issue_no, state, evidence FROM targets'))
    .toEqual([{ repo: REPO, issue_no: 282, state: 'queued', evidence: URL }])
  expect(rows(db, 'SELECT id, template, state, step, target_id FROM plans'))
    .toEqual([{ id: row.plan, template: 'pr_path', state: 'done', step: 8, target_id: row.target }])
  expect(log[0]).toBe('pr view 282 --repo solana-foundation/pay-kit --json number,url,state,title,body,closingIssuesReferences,headRefName,headRepositoryOwner')
})

test('D1 adopting writes the head branch, again on a re-adopt', () => {
  const db = fresh(schema)
  const dir = root()
  const first = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(get(dir, first.plan, PR_BRANCH)).toBe(`${BRANCH}\n`)
  drop(dir, first.plan, PR_BRANCH)
  adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(get(dir, first.plan, PR_BRANCH)).toBe(`${BRANCH}\n`)
})

test('D3 opened reads the adopted url; a pushed row wins', () => {
  const db = fresh(schema)
  const { plan } = adopt(db, root(), `${REPO}#282`, TODAY, canned())
  expect(opened(db, plan)).toBe(URL)
  const later = `https://github.com/${REPO}/pull/300`
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: TODAY })
  const approval = decide(db, 'plan', plan, 'd'.repeat(64), null)
  pushedRow(db, { plan, step: 8, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64), evidence: later }, approval)
  expect(opened(db, plan)).toBe(later)
})

test('D4 a PR off another fork is refused and nothing written', () => {
  const db = fresh(schema)
  const dir = root()
  expect(() => adopt(db, dir, `${REPO}#282`, TODAY, canned([], 270, 'outsider'))).toThrow('outsider')
  for (const table of ['accounts', 'targets', 'plans']) expect(rows(db, `SELECT id FROM ${table}`)).toEqual([])
  expect(maybe(dir, 1, PR_BRANCH)).toBeNull()
})

test('nothing pushed: no deliverable, proof or approval on the row', () => {
  const db = fresh(schema)
  adopt(db, root(), `${REPO}#282`, TODAY, canned())
  expect(rows(db, 'SELECT id FROM deliverables')).toEqual([])
  expect(rows(db, 'SELECT id FROM approvals')).toEqual([])
})

test('adopted plan packet: the PR body, then the issue it closes', () => {
  const db = fresh(schema)
  const dir = root()
  const row = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(get(dir, row.plan, 'issue.md')).toBe('# add the pay button\n\nthe button, wired to the kit\n'
    + '\n# solana-foundation/pay-kit#270 no pay button\n\nthe kit ships without one\n')
})

test('a PR closing no issue is adopted with its body as the ask', () => {
  const db = fresh(schema)
  const dir = root()
  const row = adopt(db, dir, `${REPO}#282`, TODAY, canned([], null))
  expect(get(dir, row.plan, 'issue.md')).toBe('# add the pay button\n\nthe button, wired to the kit\n')
})

test('adopting a PR twice is one row; the second call returns it', () => {
  const db = fresh(schema)
  const dir = root()
  const first = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  const again = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(again.plan).toBe(first.plan)
  expect(again.target).toBe(first.target)
  expect(again.fresh).toBe(false)
  expect(rows(db, 'SELECT count(*) AS n FROM plans')).toEqual([{ n: 1 }])
  expect(rows(db, 'SELECT count(*) AS n FROM targets')).toEqual([{ n: 1 }])
  expect(rows(db, "SELECT plan, actor, message FROM events WHERE kind = 'filed'"))
    .toEqual([{ plan: first.plan, actor: 'cf adopt', message: URL }])
  expect(render(again)).toContain('already watched')
})

test('capture reads an adopted PR like any pushed one, no replay', () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  expect(capture(db, () => view()).map((s) => [s.kind, s.author, s.plan]))
    .toEqual([['comment', 'ludo', plan], ['ci_red', 'ci', plan]])
  expect(rows(db, 'SELECT repo, pr, kind, author FROM signals ORDER BY id')).toEqual([
    { repo: REPO, pr: 282, kind: 'comment', author: 'ludo' },
    { repo: REPO, pr: 282, kind: 'ci_red', author: 'ci' },
  ])
  expect(capture(db, () => view()).filter((s) => s.kind === 'comment')).toEqual([])
})

test('adopted PR maintainer comment goes back to the brief', () => {
  const db = fresh(schema)
  const dir = root()
  const plan = adopted(db, dir)
  const packet = get(dir, plan, 'issue.md')
  const note = SignalRow.parse(capture(db, () => view())[0])
  expect(started(db, note, dir)).toMatchObject({ template: 'pr_path', plan, step: 1 })
  expect(db.prepare('SELECT step, state FROM plans WHERE id = ?').get(plan)).toEqual({ step: 1, state: 'running' })
  expect(words(note)).toContain('one nit here')
  expect(get(dir, plan, 'ask.md')).toBe(`${packet.trimEnd()}\n\n${words(note)}`)
})

test('the inherited thread is recorded and starts nothing', () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  const history = capture(db, () => view({
    comments: [comment('c9', 'greptile-apps[bot]', '2026-09-14T08:00:00Z'), comment('c8', 'caliperforge', '2026-09-16T12:00:00Z')],
    reviews: [{ id: 'r7', author: { login: 'EfeDurmaz16' }, body: 'please split this', submittedAt: '2026-09-17T18:00:00Z' }],
    statusCheckRollup: [],
  }))
  expect(history.map((s) => s.kind)).toEqual(['comment', 'review'])
  expect(history.map((s) => started(db, s))).toEqual([null, null])
  expect(db.prepare('SELECT step, state FROM plans WHERE id = ?').get(plan)).toEqual({ step: 8, state: 'done' })
})

test('approved PR: records what lands, acts only on the merge', () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  expect(capture(db, () => view({ reviewDecision: 'APPROVED' }))).toEqual([])
  expect(rows(db, 'SELECT kind, plan FROM signals ORDER BY id'))
    .toEqual([{ kind: 'comment', plan }, { kind: 'ci_red', plan }])
  const merged = capture(db, () => view({ reviewDecision: 'APPROVED', mergedAt: '2026-09-18T11:00:00Z', mergedBy: { login: 'ludo' } }))
  expect(merged.map((s) => s.kind)).toEqual(['merge'])
  expect(started(db, SignalRow.parse(merged[0]))).toMatchObject({ template: 'comms', step: 0 })
})

test('pre-adoption merge is acted on: no replay, never dropped', () => {
  const db = fresh(schema)
  adopted(db, root())
  const merged = capture(db, () => view({ mergedAt: '2026-09-17T23:00:00Z', mergedBy: { login: 'ludo' } }))
  const merge = merged.find((s) => s.kind === 'merge')
  expect(started(db, SignalRow.parse(merge))).toMatchObject({ template: 'comms', step: 0 })
})
