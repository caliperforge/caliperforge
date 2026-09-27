import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { hold } from '../../sequencer/hold.ts'
import { put } from '../../sequencer/workspace.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { flow } from '../flow.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'caliperforge/caliperforge'

const now = new Date('2026-09-26T12:00:00.000Z')

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-flow-')) })

function piped(db: Db = fresh(schema)): Db {
  db.prepare("INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1)").run()
  return db
}

function plan(db: Db, n: number, state: string): number {
  return (db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', ?, '2026-09-18', 'machine', 'typescript_specialist', ?) RETURNING id`)
    .get(n, state, `https://github.com/${REPO}/issues/${String(n)}`) as { id: number }).id
}

function pushed(db: Db, id: number): void {
  db.prepare(`INSERT OR IGNORE INTO rules (id, kind, path, content_hash, loaded_at)
    VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', ?, '2026-09-25')`).run('0'.repeat(64))
  const approval = db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('plan', ?, ?, 'gates', 'approved', '2026-09-25T00:00:00.000Z') RETURNING id`).get(id, 'd'.repeat(64)) as { id: number }
  db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere,
    fork_ci_green, bot_clean, target_warm, approval_id, evidence)
    VALUES (?, 7, 'typescript_specialist', ?, 'pushed', 1, 1, 1, 1, 1, ?, 'https://github.com/caliperforge/caliperforge/commit/abc')`)
    .run(id, 'd'.repeat(64), approval.id)
}

function refusals(db: Db, id: number, at: string, ...prints: string[]): void {
  for (const p of prints) {
    db.prepare('INSERT INTO refusals (plan, step, fingerprint, blip, at) VALUES (?, 3, ?, 0, ?)').run(id, p.repeat(64), at)
  }
}

const parked = (id: number, why = 'a person looks'): string => put(root, id, 'parked.md', `# Held\n\n${why}\n`)

test('D1-D4: one plan per case is listed once with the command that fixes it', () => {
  const db = piped()
  pushed(db, plan(db, 1, 'halted'))
  parked(plan(db, 2, 'done'))
  hold(db, root, plan(db, 3, 'running'), 'the ticket', now)
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  hold(db, root, plan(db, 5, 'running'), 'no one', now)
  db.prepare("INSERT INTO tickets (repo, number, title, lane) VALUES (?, 5, 'open', 'machine')").run(REPO)
  expect(flow(db, root, now)).toEqual([
    'plan 1\tlanded on main, state halted\tcf return 1\n',
    'plan 2\theld, state done\trm .cf/work/2/parked.md\n',
    'plan 3\theld on closed issue #3\tcf unpark 3\n',
    'plan 4\tstopped on a repeated refusal\tcf retry 4\n',
    'plan 5\theld with no owner\tcf unpark 5\n',
  ])
})

test('D5: a plan both landed and held is listed once, as landed', () => {
  const db = piped()
  pushed(db, plan(db, 1, 'halted'))
  parked(1)
  expect(flow(db, root, now)).toEqual(['plan 1\tlanded on main, state halted\tcf return 1\n'])
})

test('D5: a clean store lists nothing', () => {
  const db = piped()
  plan(db, 1, 'queued')
  expect(flow(db, root, now)).toEqual([])
})

test('D6: a young repeat, a repeat with a later decision, a hold on a plan and a non-repeat are not listed', () => {
  const db = piped()
  refusals(db, plan(db, 1, 'blocked_on_ceo'), '2026-09-26 11:31:00', 'a', 'a')
  refusals(db, plan(db, 2, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, at)
    VALUES (2, 3, 'blocked_on_ceo', 'next', 'looked', '2026-09-26 11:10:00')`).run()
  hold(db, root, plan(db, 3, 'running'), 'after plan 1', now, 1)
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'b')
  expect(flow(db, root, now)).toEqual([])
})

test('D7: flow leaves cf.db and .cf/ byte for byte as they were', () => {
  const db = open(join(root, 'cf.db'))
  migrate(db, schema)
  piped(db)
  parked(plan(db, 1, 'blocked_on_ceo'))
  refusals(db, plan(db, 2, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  const bytes = (): [string, Buffer | null][] => readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()
    .map((p) => [p, statSync(join(root, p)).isFile() ? readFileSync(join(root, p)) : null])
  const before = bytes()
  expect(flow(db, root, now)).toHaveLength(2)
  expect(bytes()).toEqual(before)
})
