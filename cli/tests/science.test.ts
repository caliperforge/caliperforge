import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { SELF } from '../../sequencer/workspace.ts'
import { ofKind, runAt } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { pull } from '../science.ts'

const schema = join(import.meta.dirname, '../../schema')

const now = new Date('2026-10-03T18:00:00.000Z')

const AT = '2026-10-02T18:00:00.000Z'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-science-')) })

function seeded(): Db {
  const db = fresh(schema)
  set(db, 'science.dir', dir, 'ceo', '2026-10-03')
  db.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1);
    INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 1, 'pr_path', 'done', '${AT}', 'machine', 'typescript_specialist', 'https://github.com/o/r/issues/1');
    INSERT INTO rules (id, kind, path, content_hash, loaded_at)
    VALUES ('typescript_specialist', 'roster', 'seats/typescript_specialist', printf('%064d', 0), '2026-09-25');
    INSERT INTO signals (repo, pr, kind, author, at, external_id, plan) VALUES ('o/r', 1, 'merge', 'me', '${AT}', 'm1', 1);
    INSERT INTO refusals (plan, step, fingerprint, blip, at) VALUES (1, 3, printf('%064d', 1), 0, '${AT}'), (1, 3, printf('%064d', 2), 0, '${AT}');
    INSERT INTO tickets (repo, number, title, lane, opened_at) VALUES ('${SELF}', 9, 'Drift: records is silent', 'machine', '${AT}');
    INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES
    (1, '${AT}', 'signoff', 'ceo', 'pass', 'x'), (1, '${AT}', 'approve', 'coo', 'pass', 'y')`)
  runAt(db, 1, 2, 'typescript_specialist', AT)
  return db
}

const lines = (name: string): string[] => readFileSync(join(dir, 'data/v2', name), 'utf8').trim().split('\n')

test('D1 D6 a seeded store writes the six CSVs and due.md', () => {
  const written = pull(seeded(), now)
  expect(written).toEqual(['runs_daily', 'plans_daily', 'drift_daily', 'operator_daily', 'stops', 'stalls']
    .map((n) => join(dir, 'data/v2', `${n}.csv`))
    .concat(join(dir, 'data/v2/due.md')))
  expect(lines('runs_daily.csv')[0]).toBe('date,seat,runs,tokens,cost_computed_usd,cost_usd,query')
  expect(lines('runs_daily.csv')[1]).toMatch(/^2026-10-02,typescript_specialist,1,0,,,"SELECT .*"$/)
  expect(lines('plans_daily.csv')[0]).toBe('date,lane,landed,refused,opened,query')
  expect(lines('plans_daily.csv')[1]).toMatch(/^2026-10-02,machine,1,1,1,"SELECT /)
  expect(lines('drift_daily.csv')[0]).toBe('date,open,opened,closed,query')
  expect(lines('drift_daily.csv').slice(1).map((l) => l.split(',"')[0])).toEqual(['2026-09-26,0,0,0', '2026-09-27,0,0,0',
    '2026-09-28,0,0,0', '2026-09-29,0,0,0', '2026-09-30,0,0,0', '2026-10-01,0,0,0', '2026-10-02,1,1,0', '2026-10-03,1,0,0'])
  expect(lines('operator_daily.csv')[0]).toBe('date,ceo,coo,signoffs,query')
  expect(lines('operator_daily.csv')[7]).toMatch(/^2026-10-02,1,1,1,"WITH /)
  expect(lines('due.md')).toEqual(['no data/interventions_v2.csv'])
})

test('D2 an unset science.dir writes nothing, records one refusal', () => {
  const db = seeded()
  set(db, 'science.dir', '', 'ceo', '2026-10-03')
  expect(pull(db, now)).toEqual([])
  expect(readdirSync(dir)).toEqual([])
  expect(ofKind(db, 'science_pull'))
    .toEqual([{ plan: null, kind: 'science_pull', actor: 'science', outcome: 'refuse', message: 'science.dir is unset' }])
})

test('D3 a missing science.dir is not created, records one event', () => {
  const db = seeded()
  const gone = join(dir, 'gone')
  set(db, 'science.dir', gone, 'ceo', '2026-10-03')
  expect(pull(db, now)).toEqual([])
  expect(existsSync(gone)).toBe(false)
  expect(ofKind(db, 'science_pull').map((e) => e.message)).toEqual([`science.dir ${gone} does not exist`])
})

test('D4 due.md lists review dates from today to before today+7', () => {
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, 'data/interventions_v2.csv'), ['id,note,review_date', '1,"soon, quoted",2026-10-06',
    '2,week,2026-10-10', '3,"was ""late""",2026-10-02', ',no id,2026-10-04'].join('\n'))
  pull(seeded(), now)
  expect(lines('due.md')).toEqual(['| id | note | review_date |', '| --- | --- | --- |', '| 1 | soon, quoted | 2026-10-06 |',
    '|  | no id | 2026-10-04 |'])
})

const cells = (name: string): string[] => lines(name).slice(1).map((l) => l.split(',"')[0] ?? '')

test('D1 D2 stops.csv gives one line per decision, who decided and how it held', () => {
  const db = seeded()
  db.exec(`INSERT INTO decisions (plan, step, wait_reason, verb, why, at) VALUES
    (1, 3, 'ceo_batch', 'retry', 'w', '2026-10-02 19:00:00'), (1, 3, 'leased', 'halt', 'w', '2026-10-02T20:00:00.000Z');
    INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, '2026-10-02T19:05:00.000Z', 'retry', 'coo', 'pass', 'z')`)
  pull(db, now)
  expect(lines('stops.csv')[0]).toBe('plan,step,wait_reason,decided_by,verb,outcome,query')
  expect(cells('stops.csv')).toEqual(['1,3,ceo_batch,coo,retry,held', '1,3,leased,,halt,'])
})

const T = '2026-10-03T10:00:00.000Z'
const plus = (minutes: number): string => new Date(Date.parse(T) + minutes * 60000).toISOString()

function stalled(state: string, event: number, live = 70, steps: number[] = []): string[] {
  const db = seeded()
  db.exec(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, wait_reason, origin)
    VALUES (2, 1, 'pr_path', '${state}', '${T}', 'machine', 'typescript_specialist', 'leased', 'https://github.com/o/r/issues/2');
    INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (2, '${plus(event)}', 'note', 'ceo', 'pass', 'x')`)
  for (let m = 5; m <= 70; m += 5) {
    db.prepare("INSERT INTO ticks (at, hhmm, dry, pipes, fired, exit, note) VALUES (?, '10:00', ?, 1, 0, 0, '')").run(plus(m), m > live ? 1 : 0)
  }
  steps.forEach((step, i) => runAt(db, 2, step, 'typescript_specialist', plus(10 + i * 20)))
  pull(db, now)
  expect(lines('stalls.csv')[0]).toBe('plan,start,end,wait_reason,woken,query')
  return cells('stalls.csv')
}

test('D3 an open plan with no mark for 61 minutes gives one stall to its last tick', () => {
  expect(stalled('queued', 61)).toEqual([`2,${T},${plus(60)},leased,0`])
})

test('D3 59 minutes gives no stall', () => {
  expect(stalled('queued', 59)).toEqual([])
})

test('D4 a run at the same step wakes the stretch without splitting it', () => {
  expect(stalled('running', 61, 70, [2, 2])).toEqual([`2,${T},${plus(60)},leased,1`])
})

test('D5 a done plan gives no stall, nor do dry ticks extend one', () => {
  expect(stalled('done', 61)).toEqual([])
  expect(stalled('queued', 61, 55)).toEqual([])
})
