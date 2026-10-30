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

const VO = vi.hoisted(() => ({ readme: 'Behaviour `async_jobs`: each client submits an async TAP query.', rows: '', listing: [] as object[] }))

vi.mock('../../cli/gh.ts', async (importOriginal) => ({
  ...await importOriginal<object>(),
  gh: (args: string[]) => {
    const path = args[1] ?? ''
    const base64 = (text: string): object => ({ content: Buffer.from(text).toString('base64'), encoding: 'base64' })
    if (path.endsWith('/contents/results')) return VO.listing
    if (path.endsWith('/contents/results/2026-10-13.jsonl')) return base64(VO.rows)
    if (path.endsWith('/readme')) return base64(VO.readme)
    if (path.includes('/commits?')) return [{ commit: { committer: { date: '2026-10-13T11:00:07Z' } } }]
    return { items: [] }
  },
}))

const schema = join(import.meta.dirname, '../../schema')

const FIRST = new Date('2026-10-14T11:20:00Z')

const REDESIGN = 'redesign-2026-10'

const DATA = ['ceo_touches', 'daily_activity', 'gate_verdicts', 'loop_counts', 'outside_pr_list', 'outside_prs','pipeline_counts', 'plan_outcomes', 'runs_by_seat', 'token_mix',
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
  git(clone, ['push', 'origin', `HEAD:${REDESIGN}`])
  VO.readme = 'Behaviour `async_jobs`: each client submits an async TAP query.'
  VO.rows = '{"client": "pyvo", "service": "CADC", "behaviour": "async_jobs", "outcome": "pass"}\n'
  VO.listing = [{ name: '2026-10-13.jsonl', path: 'results/2026-10-13.jsonl', type: 'file' }]
  set(db, 'comms.site_dir', clone, 'ceo', '2026-10-01')
})

const head = (dir: string, ref = 'HEAD'): string => git(dir, ['rev-parse', ref]).trim()

const named = (): string[] => git(clone, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter((l) => l !== '').sort()

test('D1 the first lap from 05:15 commits and pushes the data', () => {
  sitedata(db, root, FIRST)
  expect(git(clone, ['log', '-1', '--format=%s']).trim()).toBe('data: 2026-10-14')
  expect(named()).toEqual(DATA)
  expect(head(origin)).toBe(head(clone))
  expect(ofKind(db, 'site_data')).toEqual([{ plan: null, kind: 'site_data', actor: 'tick', outcome: 'pass', message: '12 files' }])
  expect(pointers(db, 'site_data')).toEqual(['2026-10-14'])
})

test('D2 a moved origin is merged under the data commit', () => {
  const other = join(root, 'other')
  git(root, ['clone', origin, other])
  for (const pair of [['user.name', 'cf test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) git(other, ['config', ...pair])
  writeFileSync(join(other, 'CNAME'), 'caliperforge.com\n')
  git(other, ['add', 'CNAME'])
  git(other, ['commit', '-m', 'theirs'])
  git(other, ['push'])
  sitedata(db, root, FIRST)
  expect(git(clone, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2)
  expect(git(clone, ['log', '-1', '--format=%s', 'HEAD^1']).trim()).toBe('data: 2026-10-14')
  expect(head(origin)).toBe(head(clone))
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

test('D6 the vo file goes to the redesign branch only', () => {
  sitedata(db, root, FIRST)
  expect(git(origin, ['show', '--name-only', '--format=%s', REDESIGN]).split('\n').filter((l) => l !== ''))
    .toEqual(['data: 2026-10-14', 'data/vo_conformance.json'])
  expect(named()).toEqual(DATA)
  expect(existsSync(join(clone, 'data/vo_conformance.json'))).toBe(false)
  expect(git(clone, ['worktree', 'list']).trim().split('\n')).toHaveLength(1)
})

test('D7 identical results a second date add no commit', () => {
  sitedata(db, root, FIRST)
  const before = head(origin, REDESIGN)
  sitedata(db, root, new Date('2026-10-15T11:20:00Z'))
  expect(pointers(db, 'site_data')).toEqual(['2026-10-14', '2026-10-15'])
  expect(head(origin, REDESIGN)).toBe(before)
})

test('D4 an undescribed behaviour refuses and leaves redesign', () => {
  VO.readme = 'Behaviour `sync_query`: each client runs a sync TAP query.'
  const before = head(origin, REDESIGN)
  sitedata(db, root, FIRST)
  expect(ofKind(db, 'site_data').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'vo_conformance.json: no description for async_jobs']])
  expect(head(origin, REDESIGN)).toBe(before)
  expect(git(clone, ['worktree', 'list']).trim().split('\n')).toHaveLength(1)
})

test('D4 an outcome outside the four refuses and leaves redesign', () => {
  VO.rows = VO.rows.replace('"pass"', '"skipped"')
  const before = head(origin, REDESIGN)
  sitedata(db, root, FIRST)
  const logged = ofKind(db, 'site_data').map((e) => [e.outcome, e.message])
  expect(logged).toEqual([['refuse', expect.stringMatching(/^vo_conformance\.json: outcome "skipped": /)]])
  expect(head(origin, REDESIGN)).toBe(before)
})

test('D5 a ZodError logs its path and message, not [', () => {
  VO.listing = [{}]
  sitedata(db, root, FIRST)
  expect(ofKind(db, 'site_data').map((e) => [e.outcome, e.message])).toEqual([['refuse', expect.stringMatching(/^0\.name: /)]])
})

test('D6 an unset site_dir is refused once per date', () => {
  set(db, 'comms.site_dir', '', 'ceo', '2026-10-02')
  sitedata(db, root, FIRST)
  sitedata(db, root, new Date('2026-10-14T11:40:00Z'))
  expect(ofKind(db, 'site_data').map((e) => [e.outcome, e.message])).toEqual([['refuse', 'comms.site_dir is unset']])
})
