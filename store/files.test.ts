import { join } from 'node:path'
import { expect, test } from 'vitest'
import { files } from '../sequencer/brief.ts'
import { record } from './files.ts'
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
