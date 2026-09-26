import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Fired } from '../../providers/kind.ts'
import { planRow } from '../../runner/index.ts'
import { load, seat } from '../../runner/rules.ts'
import { recorded } from '../seat.ts'

const root = join(import.meta.dirname, '../..')

const fired = (usage: Fired['usage']): Fired =>
  ({ text: '', transcript_path: '/tmp/cf-recorded.transcript.jsonl', usage, seconds: 1, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })

test('recorded() writes the fire\'s cost to its runs row, and NULL when the fire reports none', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { manifest, hash } = seat(root, 'typescript_specialist')
  const cost = (usage: Fired['usage']): unknown => {
    recorded(db, plan, 2, 'typescript_specialist', hash, 'claude-agent-sdk', manifest, fired(usage))
    return db.prepare('SELECT cost_usd FROM runs WHERE id = (SELECT max(id) FROM runs)').get()
  }
  expect(cost({ input: 1, cache: 2, output: 3, cost: 0.42 })).toEqual({ cost_usd: 0.42 })
  expect(cost({ input: 1, cache: 2, output: 3 })).toEqual({ cost_usd: null })
})
