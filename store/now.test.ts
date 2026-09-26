import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open, type Db } from './index.ts'
import { busy, current } from './now.ts'

const PLAN = 1
const OTHER = 2

function bench(): Db {
  const db = open(':memory:')
  migrate(db, join(import.meta.dirname, '../schema'))
  const add = db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', 'queued', '2026-09-20T00:00:00.000Z', 'machine', 'typescript_specialist', ?)`)
  for (const id of [PLAN, OTHER]) add.run(id, `https://github.com/caliperforge/caliperforge/issues/${String(id)}`)
  return db
}

test('D3 a row whose pid is dead reads as stale, and one of this process does not', () => {
  const db = bench()
  const dead = spawnSync('/usr/bin/true').pid
  busy(db, PLAN, 'model', 'brief_writer step 1')
  busy(db, OTHER, 'model', 'brief_writer step 1', new Date(), dead)
  expect(current(db).map((r) => [r.pid, r.stale])).toEqual([[process.pid, false], [dead, true]])
})

test('D4 the store refuses a pid of 0 and a since that is not an ISO date', () => {
  const db = bench()
  expect(() => { busy(db, PLAN, 'model', 'brief_writer step 1', new Date(), 0) }).toThrow(/CHECK constraint/)
  expect(() => {
    db.prepare("INSERT INTO now (plan, doing, detail, since, pid) VALUES (?, 'model', 'brief_writer step 1', 'yesterday', ?)")
      .run(PLAN, process.pid)
  }).toThrow(/CHECK constraint/)
})

test('D5 a second busy for a plan replaces its row', () => {
  const db = bench()
  busy(db, PLAN, 'model', 'brief_writer step 1')
  busy(db, PLAN, 'model', 'typescript_specialist step 2')
  expect(current(db)).toMatchObject([{ plan: PLAN, detail: 'typescript_specialist step 2' }])
})
