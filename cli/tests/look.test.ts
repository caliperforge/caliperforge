import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { world } from '../../sequencer/tests/world.ts'
import { planDir, put } from '../../sequencer/workspace.ts'
import { ofKind } from '../../store/events.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { select } from '../../store/look.ts'
import type { Read } from '../gh.ts'
import { looked, planFile, ref, thread } from '../look.ts'

/** A migrated file database with its writer left open, as a live tick holds one. */
function file(): { dir: string; path: string; handle: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'cf-look-'))
  const path = join(dir, 'cf.db')
  const handle = open(path)
  migrate(handle, join(import.meta.dirname, '../../schema'))
  return { dir, path, handle }
}

const COUNT = 'SELECT count(*) AS n FROM events'

test('D1 select returns at most 200 rows and the look logs', () => {
  const { dir, path, handle } = file()
  expect(select(path, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) SELECT i FROM n'))
    .toHaveLength(200)
  looked(handle, dir, dir, 'store SELECT 1')
  expect(ofKind(handle, 'look')).toEqual([{ plan: null, kind: 'look', actor: 'coo_lite', outcome: 'pass', message: 'store SELECT 1' }])
})

test.each<[string, string | typeof RangeError]>([
  ["INSERT INTO settings (key, value) VALUES ('x', 'y')", 'never reads settings'],
  ["INSERT INTO events (kind) VALUES ('x') RETURNING id", 'runs one SELECT'],
  ['SELECT 1; SELECT 2', RangeError],
  ['SELECT * FROM settings', 'never reads settings'],
])('D2 select refuses %s', (sql, refusal) => {
  const { path } = file()
  const before = select(path, COUNT)
  expect(() => select(path, sql)).toThrow(refusal)
  expect(select(path, COUNT)).toEqual(before)
})

test.each(['../1/x', '../../cf.db'])('D3 planFile refuses %s', (name) => {
  expect(() => planFile(mkdtempSync(join(tmpdir(), 'cf-look-')), 1, name)).toThrow('reads only inside')
})

test('D3 planFile refuses an absolute path, reads one inside', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-look-'))
  put(root, 1, 'ask.md', '# the ask\n')
  expect(() => planFile(root, 1, join(planDir(root, 1), 'ask.md'))).toThrow('reads only inside')
  expect(planFile(root, 1, 'ask.md')).toBe('# the ask\n')
})

const read: Read = (args) => args[0] === 'api'
  ? [{ id: 1, commit_id: 'a', original_commit_id: 'a', path: 'src/x.ts', line: 3, original_line: 3, body: 'tighten', user: { login: 'rev' } }]
  : { title: 'Title', body: 'the body', comments: [{ author: { login: 'ann' }, body: 'a comment' }],
    ...(args[0] === 'pr' ? { reviews: [{ author: { login: 'bob' }, body: 'a review' }] } : {}) }

test('D4 thread reads an issue, a PR and refuses a commit', () => {
  expect(thread('acme/widget', 'issue', 1, read)).toBe('Title\n\nthe body\n\n## ann\na comment')
  const pr = thread('acme/widget', 'pr', 2, read)
  expect(pr).toContain('## bob\na review')
  expect(pr).toContain('src/x.ts:3 tighten')
  expect(() => thread('acme/widget', 'commit', 3, read)).toThrow('issue or pr')
})

const SHA = 'a'.repeat(40)

test('D1 ref resolves a branch through the commits API', () => {
  const asked: string[][] = []
  expect(ref('pashov/skills', 'main', (args) => (asked.push(args), { sha: SHA }))).toBe(SHA)
  expect(asked).toEqual([['api', 'repos/pashov/skills/commits/main']])
})

test.each([
  ['https://github.com/pashov/skills', 'main'],
  ['pashov/skills/../x', 'main'],
  ['pashov/skills', '../../user'],
])('D2 ref refuses %s %s', (repo, branch) => {
  const asked: string[][] = []
  expect(() => ref(repo, branch, (args) => (asked.push(args), { sha: SHA }))).toThrow()
  expect(asked).toEqual([])
})

test('D3 thread reads an issue and a PR as before', () => {
  const asked: string[][] = []
  const recorded: Read = (args) => (asked.push(args), read(args))
  thread('acme/widget', 'issue', 1, recorded)
  thread('acme/widget', 'pr', 2, recorded)
  expect(asked.slice(0, 2)).toEqual([
    ['issue', 'view', '1', '--repo', 'acme/widget', '--json', 'title,body,comments'],
    ['pr', 'view', '2', '--repo', 'acme/widget', '--json', 'title,body,comments,reviews'],
  ])
  expect(() => thread('acme/widget', 'commit', 3, recorded)).toThrow('issue or pr')
})

test('D5 looked names the plan the command ran from', () => {
  const w = world()
  looked(w.db, w.root, join(w.root, '.cf/work/1/src'), 'plan 1 ask.md')
  expect(ofKind(w.db, 'look')).toEqual([{ plan: 1, kind: 'look', actor: 'coo_lite', outcome: 'pass', message: 'plan 1 ask.md' }])
})
