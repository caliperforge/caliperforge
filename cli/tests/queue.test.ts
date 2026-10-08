import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { get } from '../../sequencer/workspace.ts'
import { approvalsOf } from '../../store/approvals.ts'
import { allEvents, pointers } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { allPlans } from '../../store/plans.ts'
import { rulingId } from '../../store/rulings.ts'
import { addAccount, addTarget, ineligibleRuling, type Target, targetRow, targetRows } from '../../store/targets.ts'
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
  addAccount(db, { id: 1, repo: REPO, measured_at: TODAY, maintainers: 2, doors: 1, last_outsider_merge: TODAY,
    open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'warm', evidence: 'https://github.com/solana-foundation/pay-kit' })
  return db
}

const queued = (db: Db): ReturnType<typeof add> =>
  add(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), REPO, URL, 'pr-path', TODAY, { card: '# c\n' })

test('a ready target files one filed event for its plan', () => {
  const db = world()
  const added = queued(db)
  expect(allEvents(db))
    .toEqual([{ plan: added.plan, kind: 'filed', actor: 'cf queue add', outcome: 'pass', message: URL }])
})

test('a refused target writes no event', () => {
  const db = world()
  vi.mocked(claimed).mockReturnValueOnce('assigned to someone')
  expect(queued(db)).toMatchObject({ state: 'refused', plan: null })
  expect(allEvents(db)).toEqual([])
})

test('D4: a shipped issue is refused on the newest ruling', () => {
  const db = world()
  vi.mocked(implemented).mockReturnValueOnce('shipped')
  const added = add(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), REPO, URL, 'pr-path', TODAY)
  expect(added).toMatchObject({ state: 'refused', plan: null })
  expect(ineligibleRuling(db, added.target)).toBe(rulingId(db, 'queue.implemented'))
  expect(rulingId(db, 'queue.implemented')).not.toBeNull()
})

const scanned = (db: Db, state: Target['state'] = 'ready'): number => addTarget(db,
  { account_id: 1, repo: REPO, issue_no: 166, named_merger: 'maintainer', state, evidence_measured_at: TODAY, evidence: URL })

const decisions = (db: Db): unknown => approvalsOf(db, 'target')

test('approving a ready target files one plan with its ask, once', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-queue-'))
  const id = scanned(db)
  const { plan } = approve(db, root, id, 'pr-path', 'ceo', null)
  expect(decisions(db)).toEqual([{ decision: 'approved', reason: null }])
  expect(allPlans(db).filter((p) => p.target_id === id).map((p) => ({ id: p.id, template: p.template, state: p.state })))
    .toEqual([{ id: plan, template: 'pr_path', state: 'queued' }])
  expect(allEvents(db).filter((e) => e.plan === plan).map((e) => ({ kind: e.kind, actor: e.actor, outcome: e.outcome }))).toEqual([
    { kind: 'filed', actor: 'ceo', outcome: 'pass' },
    { kind: 'signoff', actor: 'ceo', outcome: 'pass' },
  ])
  expect([pointers(db, 'filed'), pointers(db, 'signoff')]).toEqual([[null], [`target:${String(id)}`]])
  expect(get(root, Number(plan), 'ask.md')).toBe('# t\n\nb\n')
  expect(approve(db, root, id, 'pr-path', 'ceo').plan).toBeNull()
  expect(allPlans(db).length).toBe(1)
})

test('D2: approving a refused target throws and writes nothing', () => {
  const db = world()
  const id = scanned(db, 'refused')
  expect(() => approve(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), id, 'pr-path', 'ceo')).toThrow(`target ${String(id)} is refused`)
  expect([decisions(db), allPlans(db).length, allEvents(db).length]).toEqual([[], 0, 0])
})

test('approving a planned target writes the row and files nothing', () => {
  const db = world()
  const added = queued(db)
  expect(approve(db, mkdtempSync(join(tmpdir(), 'cf-queue-')), added.target, 'pr-path', 'ceo').plan).toBeNull()
  expect(decisions(db)).toEqual([{ decision: 'approved', reason: null }])
  expect([allPlans(db).length, allEvents(db).length]).toEqual([1, 2])
})

test('refuseTarget writes and refuses; a bad reason leaves it be', () => {
  const db = world()
  const id = scanned(db)
  const state = (): Target['state'] => targetRow(db, id).state
  expect(() => refuseTarget(db, id, 'Not ours', 'coo')).toThrow(/CHECK/)
  expect([state(), allEvents(db).length]).toEqual(['ready', 0])
  refuseTarget(db, id, 'not.ours', 'coo')
  expect(decisions(db)).toEqual([{ decision: 'refused', reason: 'not.ours' }])
  expect(state()).toEqual('refused')
  expect(allEvents(db)).toEqual([
    { plan: null, kind: 'signoff', actor: 'coo', outcome: 'refuse', message: 'not.ours' },
  ])
  expect(pointers(db, 'signoff')).toEqual([`target:${String(id)}`])
})

test('note stores take or skip lines; the store refuses others', () => {
  const db = world()
  const id = scanned(db)
  note(db, id, 'take small and warm')
  expect(targetRows(db).map((t) => t.coo_take)).toEqual(['take small and warm'])
  for (const bad of ['maybe later', 'take a\tb', 'skip a\nb']) expect(() => { note(db, id, bad) }).toThrow(/CHECK/)
  expect(() => { note(db, 999, 'skip it') }).toThrow('no target 999')
})
