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

test('D1 a seeded store writes the four daily CSVs and due.md', () => {
  const written = pull(seeded(), now)
  expect(written).toEqual(['runs_daily', 'plans_daily', 'drift_daily', 'operator_daily'].map((n) => join(dir, 'data/v2', `${n}.csv`))
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
