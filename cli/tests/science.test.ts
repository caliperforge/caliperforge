import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { put, SELF } from '../../sequencer/workspace.ts'
import { ofKind, runAt } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { receipt } from '../../store/ticks.ts'
import { pull } from '../science.ts'

const schema = join(import.meta.dirname, '../../schema')

const now = new Date('2026-10-03T18:00:00.000Z')

const AT = '2026-10-02T18:00:00.000Z'

let dir = ''
let root = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-science-'))
  root = mkdtempSync(join(tmpdir(), 'cf-science-root-'))
})

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
  const written = pull(seeded(), root, now)
  expect(written).toEqual(['runs_daily', 'plans_daily', 'drift_daily', 'operator_daily', 'stops', 'stalls', 'review_vs_outside']
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
  expect(pull(db, root, now)).toEqual([])
  expect(readdirSync(dir)).toEqual([])
  expect(ofKind(db, 'science_pull'))
    .toEqual([{ plan: null, kind: 'science_pull', actor: 'science', outcome: 'refuse', message: 'science.dir is unset' }])
})

test('D3 a missing science.dir is not created, records one event', () => {
  const db = seeded()
  const gone = join(dir, 'gone')
  set(db, 'science.dir', gone, 'ceo', '2026-10-03')
  expect(pull(db, root, now)).toEqual([])
  expect(existsSync(gone)).toBe(false)
  expect(ofKind(db, 'science_pull').map((e) => e.message)).toEqual([`science.dir ${gone} does not exist`])
})

test('D4 due.md lists review dates from today to before today+7', () => {
  mkdirSync(join(dir, 'data'))
  writeFileSync(join(dir, 'data/interventions_v2.csv'), ['id,note,review_date', '1,"soon, quoted",2026-10-06',
    '2,week,2026-10-10', '3,"was ""late""",2026-10-02', ',no id,2026-10-04'].join('\n'))
  pull(seeded(), root, now)
  expect(lines('due.md')).toEqual(['| id | note | review_date |', '| --- | --- | --- |', '| 1 | soon, quoted | 2026-10-06 |',
    '|  | no id | 2026-10-04 |'])
})

const cells = (name: string): string[] => lines(name).slice(1).map((l) => l.split(',"')[0] ?? '')

test('D1 D2 stops.csv: one line per decision, who and how it held', () => {
  const db = seeded()
  db.exec(`INSERT INTO decisions (plan, step, wait_reason, verb, why, at) VALUES
    (1, 3, 'ceo_batch', 'retry', 'w', '2026-10-02 19:00:00'), (1, 3, 'leased', 'halt', 'w', '2026-10-02T20:00:00.000Z');
    INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, '2026-10-02T19:05:00.000Z', 'retry', 'coo', 'pass', 'z')`)
  pull(db, root, now)
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
    receipt(db, { at: plus(m), hhmm: '10:00', dry: m > live, pipes: 1, fired: 0, exit: 0, note: '' })
  }
  steps.forEach((step, i) => runAt(db, 2, step, 'typescript_specialist', plus(10 + i * 20)))
  pull(db, root, now)
  expect(lines('stalls.csv')[0]).toBe('plan,start,end,wait_reason,woken,query')
  return cells('stalls.csv')
}

test('D3 61 minutes on an open plan gives one stall to last tick', () => {
  expect(stalled('queued', 61)).toEqual([`2,${T},${plus(60)},leased,0`])
})

test('D3 59 minutes gives no stall', () => {
  expect(stalled('queued', 59)).toEqual([])
})

test('D4 a same-step run wakes the stretch without splitting it', () => {
  expect(stalled('running', 61, 70, [2, 2])).toEqual([`2,${T},${plus(60)},leased,1`])
})

test('D5 a done plan gives no stall, nor do dry ticks extend one', () => {
  expect(stalled('done', 61)).toEqual([])
  expect(stalled('queued', 61, 55)).toEqual([])
})

const verdict = (plan: number, gate: string, outcome: string): string => `INSERT INTO verdicts
  (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds) VALUES ('${gate}', 'review',
  printf('%064d', 0), ${String(plan)}, 5, '${outcome}', ${outcome === 'pass' ? 'NULL, NULL' : "'rail', 'x'"}, 0, 0);`

const greptile = (plan: number, repo: string): string => `INSERT INTO signals (repo, pr, kind, author, at, external_id, plan, score, head)
  VALUES ('${repo}', 3, 'bot_review', 'greptile-apps', '${AT}', 'g${String(plan)}', ${String(plan)}, 3, 'H');`

function outside(): Db {
  const db = seeded()
  db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/widget', '2026-09-19', 2, 1, '2026-09-19', 3, 4, 'warm', 'https://github.com/acme/widget');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 12, 'maintainer', 'ready', '2026-09-19', 'https://github.com/acme/widget/issues/12');
    INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, seat, step) VALUES
    (10, 1, 1, 'research', 'running', '${AT}', 'typescript_specialist', 2);
    ${verdict(10, 'review', 'pass')} ${verdict(10, 'senior_review', 'pass')} ${greptile(10, 'caliperforge/widget')}`)
  put(root, 10, 'findings-H.md', [1, 2, 3, 4].map((n) => `- G${String(n)} a finding\n`).join(''))
  return db
}

test('700c D1 D2 both passed, Greptile 3/5, 4 findings: one row', () => {
  pull(outside(), root, now)
  expect(lines('review_vs_outside.csv')[0]).toBe('plan,repo,code_quality,senior,greptile_score,greptile_findings,both_passed,query')
  expect(lines('review_vs_outside.csv').slice(1)).toEqual([expect.stringMatching(/^10,acme\/widget,pass,pass,3,4,1,"SELECT /)])
})

test('700c D3 internal, pre-step-6 or own-repo Greptile: no row', () => {
  const db = outside()
  db.exec(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, lane, seat, origin, step) VALUES
    (11, 1, 1, 'pr_path', 'running', '${AT}', 'machine', 'typescript_specialist', 'https://github.com/o/r/issues/2', 6);
    INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, seat, step) VALUES
    (12, 1, 1, 'research', 'running', '${AT}', 'typescript_specialist', 5), (13, 1, 1, 'research', 'running', '${AT}', 'typescript_specialist', 5);
    ${verdict(12, 'review', 'pass')} ${greptile(13, 'acme/widget')}`)
  pull(db, root, now)
  expect(cells('review_vs_outside.csv')).toEqual(['10,acme/widget,pass,pass,3,4,1'])
})

test('700c D4 newest senior verdict shows, an earlier pass counts', () => {
  const db = outside()
  db.exec(verdict(10, 'senior_review', 'refuse'))
  pull(db, root, now)
  expect(lines('review_vs_outside.csv')[1]).toMatch(/^10,acme\/widget,pass,refuse,3,4,1,"SELECT /)
})
