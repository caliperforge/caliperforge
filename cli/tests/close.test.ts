import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command } from 'commander'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { registerPlans } from '../cf-plans.ts'
import { Entry, drift } from '../../sequencer/drift.ts'
import { landed } from '../../sequencer/landed.ts'
import { measure } from '../../sequencer/steps.ts'
import { internalPlan, ours, plan, world } from '../../sequencer/tests/world.ts'
import { checkout, git, SELF } from '../../sequencer/workspace.ts'
import { gates } from '../../store/approvals.ts'
import { approved, deliverablesOf, gated } from '../../store/deliverables.ts'
import { eventsOf, logged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { dropPlan } from '../../store/plans.ts'
import { recordListing } from '../../store/tickets.ts'

const repo = join(import.meta.dirname, '../..')
const DIGEST = 'd'.repeat(64)
const ALL = { tests_pass: true, byte_identical_elsewhere: true, fork_ci_green: true, bot_clean: true, target_warm: true }

function setup(approve = true) {
  const { db, root } = world()
  dropPlan(db, 1)
  ours(root)
  internalPlan(db, root, 2)
  const { dir } = checkout(root, 2, SELF, 'p2-x')
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-28' })
  gated(db, { plan: 2, step: 3, seat: 'typescript_specialist', diff_digest: DIGEST, evidence: 'gated' }, ALL)
  if (approve) approved(db, 2, gates(db, 2, DIGEST))
  const main = git(join(root, 'remotes', SELF), ['rev-parse', 'HEAD']).trim()
  const cf = new Command()
  registerPlans(cf, { root, db: () => db, out: () => undefined })
  const run = (...args: string[]) => cf.parse(['close', '2', '--why', 'a 502 at step 7', '--by', 'coo', ...args], { from: 'user' })
  return { db, root, dir, main, run }
}

function unchanged(db: Db, state = 'approved') {
  expect(plan(db, 2).state).toBe('queued')
  expect(deliverablesOf(db, 2).map((d) => d.state)).toEqual([state])
  expect(eventsOf(db, 2, 'close')).toEqual([])
}

const entry = Entry.array().parse(parse(readFileSync(join(repo, 'rules/registry/44-close_landed.yaml'), 'utf8')))

test('D1 D6 --landed marks the approved row pushed and lands it', () => {
  const { db, main, run } = setup()
  run('--as', 'done', '--landed', main.slice(0, 7))
  expect(deliverablesOf(db, 2)).toEqual([{ state: 'pushed', evidence: `https://github.com/${SELF}/commit/${main}` }])
  expect(landed(db, 2)).toBe(true)
  expect(eventsOf(db, 2, 'close')).toEqual([{ actor: 'coo', outcome: 'pass', message: `landed ${main}: a 502 at step 7` }])
  expect(drift(db, entry, new Date())).toEqual([])
})

test('D6 the registry does not count a close landed by hand', () => {
  const db = fresh(join(repo, 'schema'))
  logged(db, { plan: null, kind: 'close', actor: 'coo', outcome: 'pass', message: 'landed by hand', pointer: null, run: null })
  expect(drift(db, entry, new Date())).toMatchObject([{ name: 'close_landed', state: 'silent' }])
})

test('D1 D2 no hand close as done gives no finding', () => {
  const db = fresh(join(repo, 'schema'))
  expect(drift(db, entry, new Date())).toEqual([])
  logged(db, { plan: null, kind: 'close', actor: 'coo', outcome: 'refuse', message: 'a 502', pointer: null, run: null })
  logged(db, { plan: null, kind: 'close', actor: 'tick', outcome: 'pass', message: 'fixed by https://x', pointer: null, run: null })
  expect(drift(db, entry, new Date())).toEqual([])
})

test('D2 an After on a plan closed --landed passes measure', () => {
  const { db, root, main, run } = setup()
  const listing = (number: number, body: string) => ({ number, title: `t${String(number)}`, body,
    url: `https://github.com/${SELF}/issues/${String(number)}`, labels: [{ name: 'lane:machine' }],
    createdAt: '2026-09-27', closedAt: null, stateReason: null })
  recordListing(db, SELF, [listing(34, 'first'), listing(35, 'second\n\nAfter: #34\n')], false)
  internalPlan(db, root, 3, 'second', 35)
  run('--as', 'done', '--landed', main)
  const measured = measure(db, root, plan(db, 3))
  expect(measured.outcome).toBe('pass')
  expect(measured.held).toBeUndefined()
})

test('D3 a sha not on main or not a commit is refused', () => {
  const { db, dir, run } = setup()
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'off main'])
  const off = git(dir, ['rev-parse', 'HEAD']).trim()
  expect(() => run('--as', 'done', '--landed', off)).toThrow(`${off} is not on main`)
  expect(() => run('--as', 'done', '--landed', 'nothing')).toThrow('nothing is not on main')
  unchanged(db)
})

test('D4 --as done with an approved row needs --landed', () => {
  const { db, run } = setup()
  expect(() => run('--as', 'done')).toThrow('--landed')
  unchanged(db)
})

test('D5 --landed with --as refused or no approved row', () => {
  const { db, main, run } = setup(false)
  expect(() => run('--landed', main)).toThrow('--landed takes --as done')
  expect(() => run('--as', 'done', '--landed', main)).toThrow('plan 2 has no approved deliverable to mark landed')
  unchanged(db, 'gated')
})

test('D5 --landed on an outside plan is refused', () => {
  const { db, root } = world()
  const cf = new Command()
  registerPlans(cf, { root, db: () => db, out: () => undefined })
  const args = ['close', '1', '--why', 'x', '--by', 'coo', '--as', 'done', '--landed', 'abc1234']
  expect(() => cf.parse(args, { from: 'user' })).toThrow('plan 1 names no issue of ours to land')
  expect(plan(db, 1).state).toBe('queued')
  expect(eventsOf(db, 1, 'close')).toEqual([])
})
