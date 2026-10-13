import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { metric, reader } from '../../store/metrics.ts'
import { exported } from '../export.ts'

const schema = join(import.meta.dirname, '../../schema')

const now = new Date('2026-10-04T12:00:00Z')

const ORDER = ['daily_activity', 'token_mix', 'runs_by_seat', 'gate_verdicts', 'plan_outcomes', 'pipeline_counts', 'tokens_per_landed_job']

const NAMES = ORDER.map((n) => `${n}.json`).sort()

const D = "printf('%064d', 0)"

const RUNS = [
  { seat: 'typescript_specialist', at: '2026-10-01T09:00:00.000Z', input_tokens: 100, cache_write_tokens: 40, cache_read_tokens: 10, output_tokens: 5 },
  { seat: 'typescript_specialist', at: '2026-10-03T09:00:00.000Z', input_tokens: 200, cache_write_tokens: 20, cache_read_tokens: 30, output_tokens: 7 },
  { seat: 'fixer', at: '2026-10-04T08:00:00.000Z', input_tokens: 50, cache_write_tokens: 10, cache_read_tokens: 0, output_tokens: 3 },
  { seat: 'typescript_specialist', at: '2026-10-04T09:00:00.000Z', input_tokens: 60, cache_write_tokens: 5, cache_read_tokens: 2, output_tokens: 1 },
]

let tmp = ''
let site = ''
let store: Db
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cf-export-'))
  site = mkdtempSync(join(tmpdir(), 'cf-export-site-'))
})

function seeded(): string {
  const path = join(tmp, 'cf.db')
  store = open(path)
  migrate(store, schema)
  store.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1);
    INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 1, 'pr_path', 'done', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/o/r/issues/1');
    INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES
    ('typescript_specialist', 'roster', 'seats/typescript_specialist', printf('%064d', 0), '2026-09-25'),
    ('fixer', 'roster', 'seats/fixer', printf('%064d', 0), '2026-09-25')`)
  for (const run of RUNS) {
    addRun(store, { ...run, plan: 1, step: 2, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high',
      cache_write_1h_tokens: null, seconds: 1, exit: 0, transcript_path: 'r.transcript.jsonl', cost_usd: 0.25 })
  }
  return path
}

function staged(): string {
  const path = seeded()
  store.exec(`INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES ('brief_writer', 'roster', 'seats/brief_writer', ${D}, '2026-09-25');
    INSERT INTO plans (id, pipe_id, template, state, queued_at) VALUES
    (2, 1, 'research', 'running', '2026-10-02'), (3, 1, 'research', 'running', '2026-10-03'), (4, 1, 'research', 'halted', '2026-10-03');
    INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds) VALUES
    ('premise', 'review', ${D}, 1, 0, 'pass', NULL, NULL, 0, 0), ('target', 'review', ${D}, 1, 0, 'refuse', 'ruling', 't', 0, 0),
    ('pre_review', 'review', ${D}, 1, 3, 'pass', NULL, NULL, 0, 0), ('pre_review', 'review', ${D}, 1, 3, 'refuse', 'rail', 'tight', 0, 0),
    ('pre_review', 'review', ${D}, 1, 3, 'pass', NULL, NULL, 0, 0), ('review', 'review', ${D}, 1, 4, 'refuse', 'ruling', 'r', 0, 0),
    ('review', 'review', ${D}, 1, 4, 'pass', NULL, NULL, 0, 0), ('blind_review', 'review', ${D}, 1, 5, 'pass', NULL, NULL, 0, 0),
    ('ready', 'review', ${D}, 1, 6, 'needs_ceo', NULL, NULL, 0, 0);
    INSERT INTO approvals (id, subject_kind, subject_id, subject_digest, who, decision, reason, approved_at) VALUES
    (1, 'deliverable', 1, ${D}, 'ceo', 'approved', NULL, '2026-10-03'), (2, 'deliverable', 2, ${D}, 'ceo', 'refused', 'too_wide', '2026-10-03'),
    (3, 'plan', 1, ${D}, 'gates', 'approved', NULL, '2026-10-03');
    INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere, fork_ci_green, bot_clean,
      target_warm, approval_id, evidence) VALUES
    (1, 2, 'typescript_specialist', ${D}, 'pushed', 1, 1, 1, 1, 1, 1, 'pr1'), (1, 2, 'typescript_specialist', ${D}, 'gated', 0, 0, 0, 0, 0, NULL, 'pr2')`)
  addRun(store, { seat: 'brief_writer', at: '2026-10-04T10:00:00.000Z', input_tokens: 10, cache_write_tokens: 0, cache_read_tokens: 0,
    output_tokens: 1, plan: 1, step: 1, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high',
    cache_write_1h_tokens: null, seconds: 1, exit: 0, transcript_path: 'b.transcript.jsonl', cost_usd: 0.25 })
  return path
}

function landed(): string {
  const path = seeded()
  store.exec(`INSERT INTO plans (id, pipe_id, template, state, queued_at) VALUES
    (5, 1, 'research', 'done', '2026-10-02'), (6, 1, 'research', 'done', '2026-10-06'), (7, 1, 'research', 'refused', '2026-10-02')`)
  for (const [plan, input_tokens, cache_read_tokens, output_tokens] of [[5, 100, 20, 10], [6, 40, 0, 2], [7, 1000, 500, 100]] as const) {
    addRun(store, { seat: 'typescript_specialist', at: '2026-10-06T09:00:00.000Z', input_tokens, cache_write_tokens: 0, cache_read_tokens,
      output_tokens, plan, step: 2, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high',
      cache_write_1h_tokens: null, seconds: 1, exit: 0, transcript_path: `${String(plan)}.transcript.jsonl`, cost_usd: 0.25 })
  }
  return path
}

const json =(name: string): { columns: string[]; rows: (string | number | null)[][] } & Record<string, unknown> =>
  JSON.parse(readFileSync(join(site, 'data', `${name}.json`), 'utf8')) as never

const direct = (sql: string): string[] => metric(store, sql, '').rows.map((r) => JSON.stringify(r)).sort()

test('D1 writes the seven files with the seven keys', () => {
  expect(exported(seeded(), site, now)).toEqual(ORDER.map((n) => join(site, 'data', `${n}.json`)))
  expect(readdirSync(join(site, 'data')).sort()).toEqual(NAMES)
  for (const name of ORDER) {
    expect(Object.keys(json(name))).toEqual(['metric', 'title', 'unit', 'columns', 'rows', 'definition', 'caveat'])
  }
})

test('D2 one row per UTC day to today, a gap day of zeros', () => {
  exported(seeded(), site, now)
  expect(json('daily_activity').columns)
    .toEqual(['day', 'runs', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'total_tokens'])
  expect(json('daily_activity').rows).toEqual([['2026-10-01', 1, 60, 10, 40, 5, 115], ['2026-10-02', 0, 0, 0, 0, 0, 0],
    ['2026-10-03', 1, 180, 30, 20, 7, 237], ['2026-10-04', 2, 95, 2, 15, 4, 116]])
})

test('D3 token_mix rows are the run sums and add to total', () => {
  exported(seeded(), site, now)
  const sum = (f: (r: (typeof RUNS)[number]) => number): number => RUNS.reduce((n, r) => n + f(r), 0)
  expect(json('token_mix').rows).toEqual([['input', sum((r) => r.input_tokens - r.cache_write_tokens)],
    ['cache_read', sum((r) => r.cache_read_tokens)], ['cache_write', sum((r) => r.cache_write_tokens)], ['output', sum((r) => r.output_tokens)]])
  const total = json('daily_activity').rows.reduce((n, r) => n + Number(r[6]), 0)
  expect(json('token_mix').rows.reduce((n, r) => n + Number(r[1]), 0)).toBe(total)
})

test('D4 runs_by_seat is sorted by runs, highest first', () => {
  exported(seeded(), site, now)
  expect(json('runs_by_seat').rows).toEqual([['typescript_specialist', 3], ['fixer', 1]])
})

test('D5 no key or column names a cost', () => {
  exported(seeded(), site, now)
  for (const name of ORDER) {
    const file = json(name)
    expect([...Object.keys(file), ...file.columns].filter((k) => /cost|usd|price|dollar/i.test(k))).toEqual([])
  }
})

test('D6 a write on the reader throws', () => {
  const path = seeded()
  expect(() => reader(path).exec('DELETE FROM runs')).toThrow(/readonly/)
})

test('D7 a failing query leaves the old files and no .tmp', () => {
  const empty = join(tmp, 'empty.db')
  writeFileSync(empty, '')
  mkdirSync(join(site, 'data'))
  for (const name of NAMES) writeFileSync(join(site, 'data', name), `old ${name}`)
  expect(() => exported(empty, site, now)).toThrow(/no such table: runs/)
  expect(readdirSync(join(site, 'data')).sort()).toEqual(NAMES)
  for (const name of NAMES) expect(readFileSync(join(site, 'data', name), 'utf8')).toBe(`old ${name}`)
})

test('D2 gate_verdicts counts the five gates in pipeline order', () => {
  exported(staged(), site, now)
  expect(json('gate_verdicts').columns).toEqual(['gate', 'outcome', 'count'])
  expect(json('gate_verdicts').rows).toEqual([['pre_review', 'pass', 2], ['pre_review', 'refuse', 1], ['review', 'pass', 1],
    ['review', 'refuse', 1], ['blind_review', 'pass', 1], ['ready', 'needs_ceo', 1]])
  expect(json('gate_verdicts').rows.map((r) => JSON.stringify(r)).sort()).toEqual(direct(`SELECT gate, outcome, count(*) FROM verdicts
    WHERE gate NOT IN ('premise', 'target') GROUP BY gate, outcome`))
})

test('D3 plan_outcomes counts plans by template and state', () => {
  exported(staged(), site, now)
  expect(json('plan_outcomes').rows).toEqual([['pr_path', 'done', 1], ['research', 'halted', 1], ['research', 'running', 2]])
  expect(json('plan_outcomes').rows.map((r) => JSON.stringify(r)).sort())
    .toEqual(direct('SELECT template, state, count(*) FROM plans GROUP BY template, state'))
})

test('D4 pipeline_counts stages come in order with their unit', () => {
  exported(staged(), site, now)
  expect(json('pipeline_counts').columns).toEqual(['stage', 'count', 'refused', 'unit'])
  expect(json('pipeline_counts').rows.map((r) => r[0]))
    .toEqual(['brief', 'build', 'rails', 'code review', 'senior review', 'ready', 'CEO approvals', 'pushed'])
  const v = ['verdicts', false]
  expect(json('pipeline_counts').rows.map((r) => [r[3], r[2] === null]))
    .toEqual([['runs', true], ['runs', true], v, v, v, v, ['approvals', true], ['deliverables', true]])
})

test('D5 each pipeline count equals its direct query', () => {
  exported(staged(), site, now)
  const counts = json('pipeline_counts').rows.map((r) => r[1])
  const one = (from: string): unknown => metric(store, `SELECT count(*) FROM ${from}`, '').rows[0]?.[0]
  expect(counts).toEqual(["runs WHERE seat = 'brief_writer'", "runs WHERE seat GLOB '*_specialist'",
    ...['pre_review', 'review', 'senior_review', 'ready'].map((g) => `verdicts WHERE gate = '${g}'`),
    "approvals WHERE who = 'ceo' AND decision = 'approved'", "deliverables WHERE state = 'pushed'"].map(one))
  expect(counts).toEqual([1, 3, 3, 2, 0, 1, 1, 1])
})

test('D7 refusals are counted and an empty gate gives zeros', () => {
  exported(staged(), site, now)
  expect(json('pipeline_counts').rows.slice(2, 6)).toEqual([['rails', 3, 1, 'verdicts'], ['code review', 2, 1, 'verdicts'],
    ['senior review', 0, 0, 'verdicts'], ['ready', 1, 0, 'verdicts']])
})

test('D1 tokens per landed job: one cohort per Monday week', () => {
  exported(landed(), site, now)
  expect(json('tokens_per_landed_job').columns)
    .toEqual(['week', 'jobs', 'mean_total_tokens', 'mean_fresh_tokens', 'mean_cache_read_tokens', 'mean_runs'])
  expect(json('tokens_per_landed_job').rows).toEqual([['2026-09-28', 2, 299, 268, 31, 2.5], ['2026-10-05', 1, 42, 42, 0, 1]])
})
