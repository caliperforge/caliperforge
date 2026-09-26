import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { ticketSection, tickets, waitLine, waits } from '../brief.ts'
import type { Db } from '../../store/index.ts'
import { waiting } from '../../store/plans.ts'

const schema = join(import.meta.dirname, '../../schema')

const HASH = 'a'.repeat(64)

/** `runs_reviewer_not_builder` refuses a reviewer who built, so each step here runs under its own seat. */
const SEATS: Record<number, string> = { 2: 'typescript_specialist', 4: 'code_quality', 5: 'senior_review' }

function world(): Db {
  const db = fresh(schema)
  for (const seat of [...Object.values(SEATS), 'orchestrator']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'seats/seat.md', ?, '2026-09-19')").run(seat, HASH)
  }
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', '2026-09-19', 2, 1, '2026-09-19', 3, 4, 'warm', 'https://github.com/acme/widget')`).run()
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 12, 'maintainer', 'ready', '2026-09-19', 'https://github.com/acme/widget/issues/12')`).run()
  return db
}

function plan(db: Db, id: number, state: string, issue: number | null, target: number | null = null): void {
  const origin = issue === null ? null : `https://github.com/caliperforge/caliperforge/issues/${String(issue)}`
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, ?, ?, ?, '2026-09-19T00:00:00.000Z', ?, 'typescript_specialist', ?)`)
    .run(id, target, issue === null ? 'research' : 'pr_path', state,
      issue === null ? null : 'machine', origin)
}

function run(db: Db, plan: number, step: number, at: string, seconds = 60, tokens = 100, seat = SEATS[step]): void {
  db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_tokens, output_tokens, seconds, exit, at, transcript_path)
    VALUES (?, ?, ?, ?, 'claude-agent-sdk', 'opus', 'high', ?, 0, 0, ?, 0, ?, 'x.transcript.jsonl')`)
    .run(plan, step, seat, HASH, tokens, seconds, at)
}

test('D4 an orchestrator run at step 4 adds to runs and tokens, not to review', () => {
  const db = world()
  plan(db, 1, 'blocked_on_ceo', 25)
  run(db, 1, 2, '2026-09-20 09:00:00')
  run(db, 1, 4, '2026-09-20 10:00:00', 60, 100, 'orchestrator')
  expect(tickets(db)).toMatchObject([{ runs: 2, build: 1, review: 0, tokens: 200 }])
})

test('every plan with a run gets a row, newest run first, with its rounds, minutes, tokens and outcome', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  plan(db, 2, 'running', 30)
  run(db, 1, 2, '2026-09-20 09:00:00', 90, 500)
  run(db, 1, 2, '2026-09-20 09:30:00', 30, 250)
  run(db, 1, 4, '2026-09-20 10:00:00', 60, 250)
  run(db, 1, 5, '2026-09-20 10:30:00', 60, 1000)
  run(db, 2, 2, '2026-09-21 08:00:00', 120, 400)
  expect(ticketSection(tickets(db))).toBe('cost per ticket (2)\n' +
    '  #30\t1 run(s)\t1 build\t0 review\t2.0 min\t400 tokens\topen\n' +
    '  #25\t4 run(s)\t2 build\t2 review\t4.0 min\t2000 tokens\tlanded\n' +
    '  before 2026-09-19 11:21\t0 ticket(s)\t- avg\n' +
    '  since 2026-09-19 11:21\t2 ticket(s)\t3.0 min avg\n')
})

test('a halted or refused plan is wasted, and the eras average the minutes of their own tickets', () => {
  const db = world()
  plan(db, 1, 'halted', 25)
  plan(db, 2, 'refused', 30)
  run(db, 1, 2, '2026-09-19 11:20:59', 600)
  run(db, 2, 2, '2026-09-19 11:21:00', 120)
  const rows = tickets(db)
  expect(rows.map((t) => t.outcome)).toEqual(['wasted', 'wasted'])
  expect(ticketSection(rows)).toContain('  before 2026-09-19 11:21\t1 ticket(s)\t10.0 min avg\n')
  expect(ticketSection(rows)).toContain('  since 2026-09-19 11:21\t1 ticket(s)\t2.0 min avg\n')
})

test('a plan with no run gets no row, and an empty era divides by nothing', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  expect(tickets(db)).toEqual([])
  expect(ticketSection(tickets(db))).toBe('cost per ticket (0)\n  none\n' +
    '  before 2026-09-19 11:21\t0 ticket(s)\t- avg\n' +
    '  since 2026-09-19 11:21\t0 ticket(s)\t- avg\n')
})

test('a plan with neither origin nor target is named by its plan id, and a target names the repo issue', () => {
  const db = world()
  plan(db, 1, 'queued', null)
  plan(db, 2, 'queued', null, 1)
  run(db, 1, 2, '2026-09-20 09:00:00')
  run(db, 2, 2, '2026-09-20 08:00:00')
  expect(ticketSection(tickets(db)).split('\n').slice(1, 3))
    .toEqual(['  plan 1\t1 run(s)\t1 build\t0 review\t1.0 min\t100 tokens\topen',
      '  acme/widget#12\t1 run(s)\t1 build\t0 review\t1.0 min\t100 tokens\topen'])
})

test('tickets() reads the db alone: no provider, no gh, one statement', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  run(db, 1, 2, '2026-09-20 09:00:00')
  const seen: string[] = []
  const handle = { prepare: (sql: string) => { seen.push(sql); return db.prepare(sql) } } as unknown as Db
  expect(tickets(handle)).toHaveLength(1)
  expect(tickets).toHaveLength(1)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain('FROM runs r JOIN plans p')
})

test('the waits line counts live plans per stored reason, ordered by reason', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'running', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'over_cap' }, { plan: 2, why: 'file_overlap', on: 1 }, { plan: 3, why: 'file_overlap', on: 1 }])
  expect(waitLine(waits(db))).toBe('waits\tfile_overlap 2\tover_cap 1\n')
})

test('a stale reason on a blocked plan and a live plan with no reason add nothing', () => {
  const db = world()
  plan(db, 1, 'blocked_on_ceo', 25)
  plan(db, 2, 'queued', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'token_ceiling' }, { plan: 2, why: null }, { plan: 3, why: 'leased' }])
  expect(waitLine(waits(db))).toBe('waits\tleased 1\n')
})

test('with no waiting live plan the waits line reads none', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  expect(waitLine(waits(db))).toBe('waits\tnone\n')
})
