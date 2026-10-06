import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { hold } from '../../sequencer/hold.ts'
import { put } from '../../sequencer/workspace.ts'
import { gates } from '../../store/approvals.ts'
import { decided } from '../../store/decisions.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addRule, migrate, open, type Db } from '../../store/index.ts'
import { hhmm, hours, set, width } from '../../store/lanes.ts'
import { addPart } from '../../store/parts.ts'
import { addPipe, openPipes, putPlan, waiting, type PlanRow } from '../../store/plans.ts'
import { refusalAt } from '../../store/refusals.ts'
import { recordListing } from '../../store/tickets.ts'
import { receipt, slots } from '../../store/ticks.ts'
import { flow, reported } from '../flow.ts'
import { all } from '../inbox.ts'

const schema = join(import.meta.dirname, '../../schema')

const REPO = 'caliperforge/caliperforge'

const now = new Date('2026-09-26T12:00:00.000Z')

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cf-flow-')) })

function piped(db: Db = fresh(schema)): Db {
  addPipe(db, { name: 'internal', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  return db
}

function plan(db: Db, n: number, state: PlanRow['state']): number {
  putPlan(db, { id: n, pipe_id: 1, target_id: null, template: 'pr_path', state, queued_at: '2026-09-18', step: 0, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/${REPO}/issues/${String(n)}` })
  return n
}

function pushed(db: Db, id: number): void {
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-25' })
  pushedRow(db, { plan: id, step: 7, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/commit/abc' }, gates(db, id, 'd'.repeat(64)))
}

function refusals(db: Db, id: number, at: string, ...prints: string[]): void {
  for (const p of prints) refusalAt(db, id, 0, at, p.repeat(64))
}

function ticket(db: Db, number: number, title: string, closedAt: string | null = null, body = ''): void {
  recordListing(db, REPO, [{ number, title, body, url: `https://github.com/${REPO}/issues/${String(number)}`,
    labels: [{ name: 'lane:machine' }], createdAt: '2026-09-18T00:00:00Z', closedAt, stateReason: null }], false)
}

const parked = (id: number): string => put(root, id, 'parked.md', '# Held\n\na person looks\n')

test('each case lists one plan once with the command fixing it', () => {
  const db = piped()
  pushed(db, plan(db, 1, 'halted'))
  parked(plan(db, 2, 'done'))
  hold(db, root, plan(db, 3, 'running'), 'the ticket', now, null, later(60))
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  hold(db, root, plan(db, 5, 'running'), 'no one', now, null, later(60))
  ticket(db, 5, 'open')
  expect(flow(db, root, now)).toEqual([
    'plan 1\tlanded on main, state halted\tcf return 1\n',
    'plan 2\theld, state done\trm .cf/work/2/parked.md\n',
    'plan 3\theld on closed issue #3\tcf unpark 3\n',
    'plan 4\tstopped on a repeated refusal\tcf retry 4\n',
    'plan 5\theld with no owner\tcf unpark 5\n',
  ])
})

test('a held plan whose ticket closed is held on a closed issue', () => {
  const db = piped()
  hold(db, root, plan(db, 3, 'running'), 'the ticket', now, null, later(60))
  ticket(db, 3, 'shut', '2026-09-26T10:00:00Z')
  expect(flow(db, root, now)).toEqual(['plan 3\theld on closed issue #3\tcf unpark 3\n'])
})

test('D5: a plan both landed and held is listed once, as landed', () => {
  const db = piped()
  pushed(db, plan(db, 1, 'halted'))
  parked(1)
  expect(flow(db, root, now)).toEqual(['plan 1\tlanded on main, state halted\tcf return 1\n'])
})

test('D4: a halted plan with no event has no reason recorded', () => {
  const db = piped()
  plan(db, 700, 'halted')
  expect(flow(db, root, now)).toEqual(['plan 700\thalted: no reason recorded\tcf return 700\n'])
})

test('D5: a clean store lists nothing', () => {
  const db = piped()
  plan(db, 1, 'queued')
  expect(flow(db, root, now)).toEqual([])
})

test('skips a young repeat, later decision, plan hold, non-repeat', () => {
  const db = piped()
  refusals(db, plan(db, 1, 'blocked_on_ceo'), '2026-09-26 11:31:00', 'a', 'a')
  refusals(db, plan(db, 2, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  decided(db, { plan: 2, step: 3, wait_reason: 'blocked_on_ceo', verb: 'next', why: 'looked', evidence: null, tokens: 0 }, '2026-09-26 11:10:00')
  hold(db, root, plan(db, 3, 'running'), 'after plan 1', now, 1)
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'b')
  expect(flow(db, root, now)).toEqual([])
})

function tick(db: Db, dry: boolean, ...lanes: [number, number, number][]): void {
  const id = receipt(db, { at: now.toISOString(), hhmm: '06:00', dry, pipes: 1, fired: 0, exit: 0, note: '' })
  slots(db, id, lanes.map(([pipe, free, startable]) => ({ pipe: { id: pipe }, free, startable })))
}

function part(db: Db, parent: number, number: number, after: number): void {
  addPart(db, { parent, n: number, url: `https://github.com/${REPO}/issues/${String(number)}`, title: 'part', body: 'body' })
  ticket(db, number, 'part', null, `After: #${String(after)}`)
}

function overlap(db: Db, on: number | null): void {
  width(db, 1, 2)
  hours(db, 1, '00:00', '23:59')
  plan(db, 2, 'queued')
  waiting(db, [{ plan: plan(db, 1, 'running'), why: 'file_overlap', on }])
}

test('lists once: slot overlap, part after closed issue, idle lane', () => {
  const db = piped()
  overlap(db, 2)
  part(db, 2, 10, 9)
  tick(db, false, [1, 1, 1])
  tick(db, false, [1, 2, 3])
  expect(flow(db, root, now)).toEqual([
    "plan 1\tholds a slot waiting on plan 2's files\tcf park 1 --on 2\n",
    'part #10\tafter #9, which is closed\tcf tick\n',
    'lane pr-path\tidle two ticks: 2 free, 3 startable\tcf lanes\n',
  ])
})

test('D7: a slot overlap on no plan parks with a time', () => {
  const db = piped()
  overlap(db, null)
  expect(flow(db, root, now)).toEqual(["plan 1\tholds a slot waiting on another job's files\tcf park 1 --until <time>\n"])
})

test('skips a lane idle one real tick, or across a dry one', () => {
  const db = piped()
  tick(db, false, [1, 0, 1])
  tick(db, true, [1, 1, 1], [2, 1, 1])
  tick(db, false, [1, 1, 1], [2, 1, 1])
  expect(flow(db, root, now)).toEqual([])
})

test('a part whose After: issue is still open is not listed', () => {
  const db = piped()
  plan(db, 2, 'queued')
  part(db, 2, 10, 9)
  ticket(db, 9, 'open')
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
  db.pragma('wal_checkpoint(TRUNCATE)')
  const before = bytes()
  expect(flow(db, root, now)).toHaveLength(2)
  expect(bytes()).toEqual(before)
})

const later = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000)

test('reported: two hourly runs on a stuck plan, one flow line', () => {
  const db = piped()
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  reported(db, root, later(60))
  expect(all(root).map((e) => [e.kind, e.plan, e.ticket])).toEqual([['flow', 4, '#4']])
})

test('reported: in-hour run writes nothing; next only new findings', () => {
  const db = piped()
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  refusals(db, plan(db, 6, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, later(30))
  expect(all(root)).toHaveLength(1)
  reported(db, root, later(60))
  expect(all(root).map((e) => e.plan)).toEqual([4, 6])
})

test('reported: no open pipe writes no inbox line and no stamp', () => {
  const db = fresh(schema)
  set(db, 'tick.zone_offset_minutes', '0', 'ceo', now.toISOString())
  for (const p of openPipes(db, hhmm(db, now))) hours(db, p.id, '03:00', '03:01')
  refusals(db, plan(db, 4, 'blocked_on_ceo'), '2026-09-26 11:00:00', 'a', 'a')
  reported(db, root, now)
  expect([existsSync(join(root, '.cf/inbox.jsonl')), existsSync(join(root, '.cf/flow.at'))]).toEqual([false, false])
})
