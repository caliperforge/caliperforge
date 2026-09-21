import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Fired } from '../../sequencer/kind.ts'
import type { Db } from '../../store/index.ts'
import { ack, events, line, notify, record, unread } from '../inbox.ts'

const schema = join(import.meta.dirname, '../../schema')

const AT = '2026-09-21T14:05:00.000Z'

function world(): Db {
  const db = fresh(schema)
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (7, 1, 'pr_path', 'running', '2026-09-21T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/49')`).run()
  return db
}

const fired = (over: Partial<Fired>): Fired =>
  ({ pipe: 'internal', plan: 7, step: 3, name: 'rails', outcome: 'pass', state: 'running', spans: [], note: 'ok', stole: null, ...over })

const LAP = [
  fired({ outcome: 'refuse', state: 'blocked_on_ceo', note: 'tight: 1 span(s) breach Tight' }),
  fired({ step: 7, name: 'batch', note: 'landed p7-x on main as 1c4263c33106' }),
  fired({ step: 4, name: 'review', outcome: 'refuse', state: 'retried', note: 'code_quality refuse' }),
  fired({ step: 2, name: 'build', note: 'typescript_specialist exit 0' }),
]

test('a lap is blocked, landed and refused events; a passing step is none', () => {
  expect(events(world(), LAP, AT).map((e) => [e.kind, e.ticket])).toEqual([['blocked', '#49'], ['landed', '#49'], ['refused', '#49']])
})

test('only blocked, landed and done reach the desktop', () => {
  const posted: string[] = []
  notify(events(world(), LAP, AT), (title) => posted.push(title))
  expect(posted).toEqual(['cf: #49 blocked', 'cf: #49 landed'])
})

test('unread is everything after the last ack', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-inbox-'))
  record(root, events(db, LAP.slice(0, 2), AT))
  expect(unread(root)).toHaveLength(2)
  expect(ack(root)).toBe(2)
  expect(unread(root)).toEqual([])
  record(root, events(db, LAP.slice(2), AT))
  expect(unread(root).map((e) => e.kind)).toEqual(['refused'])
})

test('a line reads in the store\'s local time', () => {
  const db = world()
  db.prepare("UPDATE settings SET value = '-360' WHERE key = 'tick.zone_offset_minutes'").run()
  expect(events(db, LAP.slice(1, 2), AT).map((e) => line(db, e))[0]).toMatch(/^08:05 {2}landed {3}#49 \(plan 7\) at step 7 batch: landed/)
})
