import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { capture } from '../../sequencer/capture.ts'
import { started } from '../../sequencer/signals.ts'
import { get } from '../../sequencer/workspace.ts'
import { SignalRow } from '../../store/signals.ts'
import type { Db } from '../../store/index.ts'
import { adopt, render } from '../adopt.ts'
import type { Pr, Read } from '../gh.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'solana-foundation/pay-kit'

const URL = `https://github.com/${REPO}/pull/282`

const TODAY = '2026-09-18'

const ADOPTED = '2026-09-18T09:09:00.000Z'

/** The `gh` shapes adopt reads: the pull request, the issue it closes, and the three `cf measure` takes its pulse from. */
function canned(log: string[] = [], linked: number | null = 270): Read {
  return (args) => {
    log.push(args.join(' '))
    if (args[0] === 'pr' && args[1] === 'view') {
      return { number: 282, url: URL, state: 'OPEN', title: 'add the pay button', body: 'the button, wired to the kit',
        closingIssuesReferences: linked === null ? [] : [{ number: linked }] }
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

test('cf adopt files one plan at the pushed step, with the targets and accounts rows it needs', () => {
  const db = fresh(schema)
  const log: string[] = []
  const row = adopt(db, root(), `${REPO}#282`, TODAY, canned(log))
  expect(row).toMatchObject({ repo: REPO, pr: 282, url: URL, fresh: true })
  expect(rows(db, 'SELECT repo, measured_at FROM accounts')).toEqual([{ repo: REPO, measured_at: TODAY }])
  expect(rows(db, 'SELECT repo, issue_no, state, evidence FROM targets'))
    .toEqual([{ repo: REPO, issue_no: 282, state: 'queued', evidence: URL }])
  expect(rows(db, 'SELECT id, template, state, step, target_id FROM plans'))
    .toEqual([{ id: row.plan, template: 'pr_path', state: 'done', step: 8, target_id: row.target }])
  expect(log[0]).toBe('pr view 282 --repo solana-foundation/pay-kit --json number,url,state,title,body,closingIssuesReferences')
})

test('nothing is pushed: the adopted row carries no deliverable, no proof and no approval', () => {
  const db = fresh(schema)
  adopt(db, root(), `${REPO}#282`, TODAY, canned())
  expect(rows(db, 'SELECT id FROM deliverables')).toEqual([])
  expect(rows(db, 'SELECT id FROM approvals')).toEqual([])
})

test('the adopted plan carries an issue packet: the pull request body, then the issue it closes', () => {
  const db = fresh(schema)
  const dir = root()
  const row = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(get(dir, row.plan, 'issue.md')).toBe('# add the pay button\n\nthe button, wired to the kit\n'
    + '\n# solana-foundation/pay-kit#270 no pay button\n\nthe kit ships without one\n')
})

test('a pull request that closes no issue is adopted with its own body as the ask', () => {
  const db = fresh(schema)
  const dir = root()
  const row = adopt(db, dir, `${REPO}#282`, TODAY, canned([], null))
  expect(get(dir, row.plan, 'issue.md')).toBe('# add the pay button\n\nthe button, wired to the kit\n')
})

test('adopting the same pull request twice is one plan row, and the second call returns the first', () => {
  const db = fresh(schema)
  const dir = root()
  const first = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  const again = adopt(db, dir, `${REPO}#282`, TODAY, canned())
  expect(again.plan).toBe(first.plan)
  expect(again.target).toBe(first.target)
  expect(again.fresh).toBe(false)
  expect(rows(db, 'SELECT count(*) AS n FROM plans')).toEqual([{ n: 1 }])
  expect(rows(db, 'SELECT count(*) AS n FROM targets')).toEqual([{ n: 1 }])
  expect(render(again)).toContain('already watched')
})

test('capture reads an adopted pull request like any v2 pushed one, and replays nothing', () => {
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

test("a maintainer's comment on an adopted pull request puts its plan back on the review step", () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  const note = capture(db, () => view())[0]
  expect(started(db, SignalRow.parse(note))).toMatchObject({ template: 'pr_path', plan, step: 4 })
  expect(db.prepare('SELECT step, state FROM plans WHERE id = ?').get(plan)).toEqual({ step: 4, state: 'running' })
})

test('the thread the adoption inherited is recorded and starts nothing', () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  const history = capture(db, () => view({
    comments: [comment('c9', 'greptile-apps[bot]', '2026-09-14T08:00:00Z'), comment('c8', 'caliperforge', '2026-09-16T12:00:00Z')],
    reviews: [{ id: 'r7', author: { login: 'EfeDurmaz16' }, body: 'please split this', submittedAt: '2026-09-17T18:00:00Z' }],
    statusCheckRollup: [],
  }))
  expect(history.map((s) => s.kind)).toEqual(['comment', 'comment', 'review'])
  expect(history.map((s) => started(db, s))).toEqual([null, null, null])
  expect(db.prepare('SELECT step, state FROM plans WHERE id = ?').get(plan)).toEqual({ step: 8, state: 'done' })
})

test('an approved pull request is left alone: what lands on it is recorded, and only the merge is acted on', () => {
  const db = fresh(schema)
  const plan = adopted(db, root())
  expect(capture(db, () => view({ reviewDecision: 'APPROVED' }))).toEqual([])
  expect(rows(db, 'SELECT kind, plan FROM signals ORDER BY id'))
    .toEqual([{ kind: 'comment', plan }, { kind: 'ci_red', plan }])
  const merged = capture(db, () => view({ reviewDecision: 'APPROVED', mergedAt: '2026-09-18T11:00:00Z', mergedBy: { login: 'ludo' } }))
  expect(merged.map((s) => s.kind)).toEqual(['merge'])
  expect(started(db, SignalRow.parse(merged[0]))).toMatchObject({ template: 'comms', step: 0 })
})

test('a merge that predates the adoption is still acted on: history is never replayed, a merge is never dropped', () => {
  const db = fresh(schema)
  adopted(db, root())
  const merged = capture(db, () => view({ mergedAt: '2026-09-17T23:00:00Z', mergedBy: { login: 'ludo' } }))
  const merge = merged.find((s) => s.kind === 'merge')
  expect(started(db, SignalRow.parse(merge))).toMatchObject({ template: 'comms', step: 0 })
})
