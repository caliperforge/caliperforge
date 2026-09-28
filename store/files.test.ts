import { join } from 'node:path'
import { expect, test } from 'vitest'
import { files } from '../sequencer/brief.ts'
import { edit, filesOf, record, strays } from './files.ts'
import { migrate, open, type Db } from './index.ts'

const root = join(import.meta.dirname, '..')

const PLAN = 1

function bench(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/61')`).run(PLAN)
  return db
}

function briefOf(...lines: string[]): string {
  return `# a job\n\n## Files\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\n## Out of scope\n\n- the rest\n`
}

function rows(db: Db): unknown[] {
  return db.prepare('SELECT path, is_new FROM plan_files WHERE plan = ? ORDER BY position').all(PLAN)
}

test('the three paths the brief names are three rows in the order it listed them', () => {
  const db = bench()
  record(db, PLAN, files(briefOf('sequencer/brief.ts', 'store/files.ts', 'schema/0017_plan_files.sql')))

  expect(rows(db)).toEqual([
    { path: 'sequencer/brief.ts', is_new: 0 },
    { path: 'store/files.ts', is_new: 0 },
    { path: 'schema/0017_plan_files.sql', is_new: 0 },
  ])
})

test('a line number is dropped from the path and (new) sets the flag', () => {
  const db = bench()
  record(db, PLAN, files(briefOf('`a/b.ts:41`', 'c/d.ts (new)')))

  expect(rows(db)).toEqual([{ path: 'a/b.ts', is_new: 0 }, { path: 'c/d.ts', is_new: 1 }])
})

test('a second list leaves only its own paths', () => {
  const db = bench()
  record(db, PLAN, files(briefOf('a/b.ts', 'c/d.ts')))

  record(db, PLAN, files(briefOf('e/f.ts')))
  expect(rows(db)).toEqual([{ path: 'e/f.ts', is_new: 0 }])
})

test('a brief with no ## Files heading leaves no rows and throws nothing', () => {
  const db = bench()

  record(db, PLAN, files('# a job\n\n## Out of scope\n\n- the rest\n'))
  expect(rows(db)).toEqual([])
})

test('a plan id no plans row carries is refused', () => {
  const db = bench()

  expect(() => { record(db, PLAN + 1, [{ path: 'a/b.ts', is_new: false }]) }).toThrow(/FOREIGN KEY/)
})

const events = (db: Db) => db.prepare('SELECT plan, kind, actor, outcome, message FROM events').all()

test('D1 add lists a new path and writes one files event', () => {
  const db = bench()
  edit(db, PLAN, 'add', 'a.ts', 'coo', null)
  expect(rows(db)).toEqual([{ path: 'a.ts', is_new: 1 }])
  expect(events(db)).toEqual([{ plan: PLAN, kind: 'files', actor: 'coo', outcome: 'pass', message: 'add a.ts' }])
})

test('D2 drop removes the listed row, and a drop of an unlisted path changes nothing', () => {
  const db = bench()
  record(db, PLAN, [{ path: 'a.ts', is_new: false }, { path: 'b.ts', is_new: false }])
  edit(db, PLAN, 'drop', 'a.ts', 'ceo', 'wrong file')
  expect(rows(db)).toEqual([{ path: 'b.ts', is_new: 0 }])
  expect(events(db)).toEqual([{ plan: PLAN, kind: 'files', actor: 'ceo', outcome: 'pass', message: 'drop a.ts: wrong file' }])
  expect(() => { edit(db, PLAN, 'drop', 'c.ts', 'coo', null) }).toThrow(`plan ${String(PLAN)} does not list c.ts`)
  expect(rows(db)).toEqual([{ path: 'b.ts', is_new: 0 }])
  expect(events(db)).toHaveLength(1)
})

test('D3 set leaves one listed row and keeps strays on other paths', () => {
  const db = bench()
  record(db, PLAN, [{ path: 'a.ts', is_new: false }])
  strays(db, PLAN, ['s.ts'])
  edit(db, PLAN, 'set', 'b.ts', 'coo', null)
  expect(filesOf(db, PLAN)).toEqual([{ path: 'b.ts', is_new: true }])
  expect(db.prepare('SELECT path FROM plan_files WHERE plan = ? AND stray = 1').all(PLAN)).toEqual([{ path: 's.ts' }])
})

test('D5 an edit on a missing plan writes nothing', () => {
  const db = bench()
  expect(() => { edit(db, 99, 'add', 'a.ts', 'coo', null) }).toThrow('no plan 99')
  expect(db.prepare('SELECT count(*) AS n FROM plan_files').get()).toEqual({ n: 0 })
  expect(events(db)).toEqual([])
})
