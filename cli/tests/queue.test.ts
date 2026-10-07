import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { get } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import { rulingId } from '../../store/rulings.ts'
import { ineligibleRuling } from '../../store/targets.ts'
import { claimed, implemented } from '../gh.ts'
import { add, approve, note, refuseTarget } from '../queue.ts'

vi.mock('../gh.ts', async (importOriginal) => ({
  ...await importOriginal<object>(),
  issue: () => ({ number: 166, title: 't', body: 'b', state: 'OPEN', assignees: [], comments: [], closedByPullRequestsReferences: [] }),
  lastMerger: () => 'maintainer',
  claimed: vi.fn(() => null),
  implemented: vi.fn(() => null),
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

test('D4: a shipped issue is refused on the newest ruling', () => {
  const db = world()
  vi.mocked(implemented).mockReturnValueOnce('shipped')
  const added = add(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), REPO, URL, 'pr-path', TODAY)
  expect(added).toMatchObject({ state: 'refused', plan: null })
  expect(ineligibleRuling(db, added.target)).toBe(rulingId(db, 'queue.implemented'))
  expect(rulingId(db, 'queue.implemented')).not.toBeNull()
})

const scanned = (db: Db, state = 'ready'): number => Number(db.prepare(`INSERT INTO targets
  (account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence) VALUES (1, ?, 166, 'maintainer', ?, ?, ?)`)
  .run(REPO, state, TODAY, URL).lastInsertRowid)

const decisions = (db: Db): unknown => db.prepare("SELECT decision, reason FROM approvals WHERE subject_kind = 'target'").all()

const count = (db: Db, table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test('approving a ready target files one plan with its ask, once', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-queue-'))
  const id = scanned(db)
  const { plan } = approve(db, root, id, 'pr-path', 'ceo', null)
  expect(decisions(db)).toEqual([{ decision: 'approved', reason: null }])
  expect(db.prepare('SELECT id, template, state FROM plans WHERE target_id = ?').all(id))
    .toEqual([{ id: plan, template: 'pr_path', state: 'queued' }])
  expect(db.prepare('SELECT kind, actor, outcome, pointer FROM events WHERE plan = ?').all(plan)).toEqual([
    { kind: 'filed', actor: 'ceo', outcome: 'pass', pointer: null },
    { kind: 'signoff', actor: 'ceo', outcome: 'pass', pointer: `target:${String(id)}` },
  ])
  expect(get(root, Number(plan), 'ask.md')).toBe('# t\n\nb\n')
  expect(approve(db, root, id, 'pr-path', 'ceo').plan).toBeNull()
  expect(count(db, 'plans')).toBe(1)
})

test('D2: approving a refused target throws and writes nothing', () => {
  const db = world()
  const id = scanned(db, 'refused')
  expect(() => approve(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), id, 'pr-path', 'ceo')).toThrow(`target ${String(id)} is refused`)
  expect([decisions(db), count(db, 'plans'), count(db, 'events')]).toEqual([[], 0, 0])
})

test('approving a planned target writes the row and files nothing', () => {
  const db = world()
  const added = queued(db)
  expect(approve(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), added.target, 'pr-path', 'ceo').plan).toBeNull()
  expect(decisions(db)).toEqual([{ decision: 'approved', reason: null }])
  expect([count(db, 'plans'), count(db, 'events')]).toEqual([1, 2])
})

test('refuseTarget writes and refuses; a bad reason leaves it be', () => {
  const db = world()
  const id = scanned(db)
  const state = (): unknown => db.prepare('SELECT state FROM targets WHERE id = ?').get(id)
  expect(() => refuseTarget(db, id, 'Not ours', 'coo')).toThrow(/CHECK/)
  expect([state(), count(db, 'events')]).toEqual([{ state: 'ready' }, 0])
  refuseTarget(db, id, 'not.ours', 'coo')
  expect(decisions(db)).toEqual([{ decision: 'refused', reason: 'not.ours' }])
  expect(state()).toEqual({ state: 'refused' })
  expect(db.prepare('SELECT plan, kind, actor, outcome, message, pointer FROM events').all()).toEqual([
    { plan: null, kind: 'signoff', actor: 'coo', outcome: 'refuse', message: 'not.ours', pointer: `target:${String(id)}` },
  ])
})

test('note stores take or skip lines; the store refuses others', () => {
  const db = world()
  const id = scanned(db)
  note(db, id, 'take small and warm')
  expect(db.prepare('SELECT coo_take FROM targets WHERE id = ?').get(id)).toEqual({ coo_take: 'take small and warm' })
  for (const bad of ['maybe later', 'take a\tb', 'skip a\nb']) expect(() => { note(db, id, bad) }).toThrow(/CHECK/)
  expect(() => { note(db, 999, 'skip it') }).toThrow('no target 999')
})
