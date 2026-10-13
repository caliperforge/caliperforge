import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { reader } from '../../store/metrics.ts'
import { exported } from '../export.ts'

const schema = join(import.meta.dirname, '../../schema')

const now = new Date('2026-10-04T12:00:00Z')

const NAMES = ['daily_activity.json', 'runs_by_seat.json', 'token_mix.json']

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

const json = (name: string): { columns: string[]; rows: (string | number)[][] } & Record<string, unknown> =>
  JSON.parse(readFileSync(join(site, 'data', `${name}.json`), 'utf8')) as never

test('D1 writes the three files with the seven keys', () => {
  expect(exported(seeded(), site, now)).toEqual(['daily_activity', 'token_mix', 'runs_by_seat'].map((n) => join(site, 'data', `${n}.json`)))
  expect(readdirSync(join(site, 'data')).sort()).toEqual(NAMES)
  for (const name of ['daily_activity', 'token_mix', 'runs_by_seat']) {
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
  for (const name of ['daily_activity', 'token_mix', 'runs_by_seat']) {
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
