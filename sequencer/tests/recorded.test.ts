import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Fired } from '../../providers/kind.ts'
import { planRow } from '../../runner/index.ts'
import { load, seat } from '../../runner/rules.ts'
import type { Db } from '../../store/index.ts'
import { recorded } from '../seat.ts'

const root = join(import.meta.dirname, '../..')

const fired = (usage: Fired['usage']): Fired =>
  ({ text: '', transcript_path: '/tmp/cf-recorded.transcript.jsonl', usage, seconds: 1, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })

const newest = (db: Db, column: string): unknown =>
  db.prepare(`SELECT ${column} FROM runs WHERE id = (SELECT max(id) FROM runs)`).pluck().get()

test('recorded() writes the fire\'s cost, or NULL when it has none', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { manifest, hash } = seat(root, 'typescript_specialist')
  const cost = (usage: Fired['usage']): unknown => {
    recorded(db, plan, 2, 'typescript_specialist', hash, 'claude-agent-sdk', manifest, fired(usage))
    return newest(db, 'cost_usd')
  }
  expect(cost({ input: 1, cache: 2, output: 3, cost: 0.42 })).toBe(0.42)
  expect(cost({ input: 1, cache: 2, output: 3 })).toBeNull()
})

test('D2 recorded() writes the mode, or NULL without one', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { manifest, hash } = seat(root, 'typescript_specialist')
  recorded(db, plan, 2, 'typescript_specialist', hash, 'claude-agent-sdk', manifest, fired({ input: 1, cache: 0, output: 0 }), 'fix')
  expect(newest(db, 'mode')).toBe('fix')
  recorded(db, plan, 2, 'typescript_specialist', hash, 'claude-agent-sdk', manifest, fired({ input: 1, cache: 0, output: 0 }))
  expect(newest(db, 'mode')).toBeNull()
})
