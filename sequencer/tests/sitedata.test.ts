import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { ofKind, pointers } from '../../store/events.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { set } from '../../store/lanes.ts'
import { sitedata } from '../site.ts'
import { git } from '../workspace.ts'

vi.mock('../../cli/gh.ts', async (importOriginal) => ({ ...await importOriginal<object>(), gh: () => ({ items: [] }) }))

const schema = join(import.meta.dirname, '../../schema')

const FIRST = new Date('2026-10-14T11:20:00Z')

const DATA = ['ceo_touches', 'daily_activity', 'gate_verdicts', 'outside_prs', 'pipeline_counts', 'plan_outcomes', 'runs_by_seat', 'token_mix',
  'tokens_per_landed_job'].map((n) => `data/${n}.json`)

const RUN = { at: '2026-10-13T09:00:00.000Z', input_tokens: 10, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 1, plan: 1,
  step: 2, rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm', effort: 'high', cache_write_1h_tokens: null, seconds: 1,
  exit: 0, transcript_path: 'r.transcript.jsonl', cost_usd: 0.25 }

let root = ''
let origin = ''
let clone = ''
let db: Db
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-sitedata-'))
  db = open(join(root, 'cf.db'))
  migrate(db, schema)
  db.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES ('internal', 1, '00:00', '23:59', 1);
    INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (1, 1, 'pr_path', 'done', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/o/r/issues/1');
    INSERT INTO rules (id, kind, path, content_hash, loaded_at) VALUES
    ('typescript_specialist', 'roster', 'seats/typescript_specialist', printf('%064d', 0), '2026-09-25'),
    ('cost_usd', 'roster', 'seats/cost_usd', printf('%064d', 0), '2026-09-25')`)
  addRun(db, { ...RUN, seat: 'typescript_specialist' })
  set(db, 'tick.zone_offset_minutes', '-360', 'ceo', '2026-10-01')
  origin = join(root, 'origin.git')
  clone = join(root, 'site')
  git(root, ['init', '--bare', '-b', 'main', origin])
  git(root, ['clone', origin, clone])
  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const pair of [['user.name', 'cf test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) {
    git(clone, ['config', ...pair])
  }
  writeFileSync(join(clone, 'README.md'), 'site\n')
  git(clone, ['add', 'README.md'])
  git(clone, ['commit', '-m', 'initial'])
  git(clone, ['push', '-u', 'origin', 'HEAD'])
  set(db, 'comms.site_dir', clone, 'ceo', '2026-10-01')
})

const head = (dir: string): string => git(dir, ['rev-parse', 'HEAD']).trim()

const named = (): string[] => git(clone, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter((l) => l !== '').sort()

test('D1 the first lap from 05:15 commits and pushes the data', () => {
  sitedata(db, root, FIRST)
  expect(git(clone, ['log', '-1', '--format=%s']).trim()).toBe('data: 2026-10-14')
  expect(named()).toEqual(DATA)
  expect(head(origin)).toBe(head(clone))
  expect(ofKind(db, 'site_data')).toEqual([{ plan: null, kind: 'site_data', actor: 'tick', outcome: 'pass', message: '9 files' }])
  expect(pointers(db, 'site_data')).toEqual(['2026-10-14'])
})

test('D2 a second lap the same date does nothing', () => {
  sitedata(db, root, FIRST)
  const before = head(clone)
  addRun(db, { ...RUN, seat: 'typescript_specialist', at: '2026-10-14T10:00:00.000Z' })
  sitedata(db, root, new Date('2026-10-14T11:40:00Z'))
  expect(head(clone)).toBe(before)
  expect(head(origin)).toBe(before)
  expect(ofKind(db, 'site_data')).toHaveLength(1)
})

test('D3 a lap before 05:15 logs nothing and writes nothing', () => {
  sitedata(db, root, new Date('2026-10-14T11:10:00Z'))
  expect(ofKind(db, 'site_data')).toEqual([])
  expect(existsSync(join(clone, 'data'))).toBe(false)
})

test('D4 a cost_usd seat is refused with a clean checkout', () => {
  addRun(db, { ...RUN, seat: 'cost_usd' })
  sitedata(db, root, FIRST)
  expect(ofKind(db, 'site_data').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'runs_by_seat.json: cost_usd']])
  expect(git(clone, ['status', '--porcelain'])).toBe('')
})

test('D5 files outside data/ are never staged', () => {
  writeFileSync(join(clone, 'README.md'), 'changed\n')
  writeFileSync(join(clone, 'notes.txt'), 'draft\n')
  sitedata(db, root, FIRST)
  expect(named()).toEqual(DATA)
  expect(git(clone, ['status', '--porcelain']).split('\n').filter((l) => l !== '')).toEqual([' M README.md', '?? notes.txt'])
})

test('D6 an unset site_dir is refused once per date', () => {
  set(db, 'comms.site_dir', '', 'ceo', '2026-10-02')
  sitedata(db, root, FIRST)
  sitedata(db, root, new Date('2026-10-14T11:40:00Z'))
  expect(ofKind(db, 'site_data').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'comms.site_dir is unset']])
})
