import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { hold } from '../../sequencer/hold.ts'
import { put } from '../../sequencer/workspace.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { receipt, slots } from '../../store/ticks.ts'
import { flow, reported } from '../flow.ts'
import { all } from '../inbox.ts'

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
  db.prepare(`INSERT INTO rules (id, kind, path, content_hash, loaded_at)
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

const parked = (id: number): string => put(root, id, 'parked.md', '# Held\n\na person looks\n')

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

function tick(db: Db, dry: boolean, ...lanes: [number, number, number][]): void {
  const id = receipt(db, { at: now.toISOString(), hhmm: '06:00', dry, pipes: 1, fired: 0, exit: 0, note: '' })
  slots(db, id, lanes.map(([pipe, free, startable]) => ({ pipe: { id: pipe }, free, startable })))
}

function part(db: Db, parent: number, number: number, after: number): void {
  db.prepare("INSERT INTO parts (parent, n, url, title, body) VALUES (?, ?, ?, 'part', 'body')")
    .run(parent, number, `https://github.com/${REPO}/issues/${String(number)}`)
  db.prepare("INSERT INTO tickets (repo, number, title, lane, after) VALUES (?, ?, 'part', 'machine', ?)").run(REPO, number, after)
}

test('393b D1-D3: an overlap holding a slot, a part after a closed issue and an idle lane are each listed once', () => {
  const db = piped()
  db.prepare("UPDATE pipes SET max_concurrent = 2, window_start = '00:00', window_end = '23:59' WHERE id = 1").run()
  plan(db, 2, 'queued')
  db.prepare("UPDATE plans SET wait_reason = 'file_overlap', waits_on = 2 WHERE id = ?").run(plan(db, 1, 'running'))
  part(db, 2, 10, 9)
  tick(db, false, [1, 1, 1])
  tick(db, false, [1, 2, 3])
  expect(flow(db, root, now)).toEqual([
    "plan 1\tholds a slot waiting on plan 2's files\tcf park 1 --on 2\n",
    'part #10\tafter #9, which is closed\tcf tick\n',
    'lane pr-path\tidle two ticks: 2 free, 3 startable\tcf lanes\n',
  ])
})

test('393b D4: a lane idle on only the latest real tick, or across a dry one, is not listed', () => {
  const db = piped()
  tick(db, false, [1, 0, 1])
  tick(db, true, [1, 1, 1], [2, 1, 1])
  tick(db, false, [1, 1, 1], [2, 1, 1])
  expect(flow(db, root, now)).toEqual([])
})

test('393b D2: a part whose After: issue is still open is not listed', () => {
  const db = piped()
  plan(db, 2, 'queued')
  part(db, 2, 10, 9)
  db.prepare("INSERT INTO tickets (repo, number, title, lane) VALUES (?, 9, 'open', 'machine')").run(REPO)
  expect(flow(db, root, now)).toEqual([])
})

test('393b D6: a negative free count fails its CHECK', () => {
  const db = piped()
  expect(() => { tick(db, false, [1, -1, 0]) }).toThrow(/CHECK/)
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

const later = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000)

test('reported D1: two hourly runs over the same stuck plan leave one flow line', () => {
  const db = piped()
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  reported(db, root, later(60))
  expect(all(root).map((e) => [e.kind, e.plan, e.ticket])).toEqual([['flow', 4, '#4']])
})

test('reported D2: a run inside the hour writes nothing; the next writes only the new finding', () => {
  const db = piped()
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  refusals(db, plan(db, 6, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, later(30))
  expect(all(root)).toHaveLength(1)
  reported(db, root, later(60))
  expect(all(root).map((e) => e.plan)).toEqual([4, 6])
})

test('reported D3: with no open pipe it writes no inbox line and no stamp', () => {
  const db = fresh(schema)
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'tick.zone_offset_minutes'").run()
  db.prepare("UPDATE pipes SET window_start = '03:00', window_end = '03:01'").run()
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  expect([existsSync(join(root, '.cf/inbox.jsonl')), existsSync(join(root, '.cf/flow.at'))]).toEqual([false, false])
})
