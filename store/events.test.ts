import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import type { Fired } from '../providers/kind.ts'
import { planRow } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import { runAt, runLogged } from './events.ts'

const root = join(import.meta.dirname, '..')

test('runLogged writes every column as given, cache into cache_read_tokens, and NULL for a missing cost', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { hash } = seat(root, 'typescript_specialist')
  const row = (usage: Fired['usage']): unknown => {
    const id = runLogged(db, { plan, step: 4, seat: 'typescript_specialist', rule_hash: hash, provider: 'claude-agent-sdk',
      model: 'm', effort: 'high', exit: 1, fired: { usage, seconds: 7, transcript_path: 'x.transcript.jsonl' } })
    return db.prepare(`SELECT plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_read_tokens, output_tokens,
      seconds, exit, transcript_path, cost_usd FROM runs WHERE id = ?`).get(id)
  }
  const written = {
    plan, step: 4, seat: 'typescript_specialist', rule_hash: hash, provider: 'claude-agent-sdk', model: 'm', effort: 'high',
    input_tokens: 1, cache_read_tokens: 2, output_tokens: 3, seconds: 7, exit: 1, transcript_path: 'x.transcript.jsonl',
  }
  expect(row({ input: 1, cache: 2, output: 3, cost: 0.42 })).toEqual({ ...written, cost_usd: 0.42 })
  expect(row({ input: 1, cache: 2, output: 3 })).toEqual({ ...written, cost_usd: null })
})

test('D2 D3: runLogged writes cache_write_tokens, NULL when absent, and refuses a negative one', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const { hash } = seat(root, 'typescript_specialist')
  const log = (usage: Fired['usage']): number => runLogged(db, { plan, step: 4, seat: 'typescript_specialist', rule_hash: hash,
    provider: 'claude-agent-sdk', model: 'm', effort: 'high', exit: 0, fired: { usage, seconds: 1, transcript_path: 'x.transcript.jsonl' } })
  const writes = (id: number): unknown => db.prepare('SELECT cache_write_tokens FROM runs WHERE id = ?').get(id)
  expect(writes(log({ input: 1, cache: 2, output: 3 }))).toEqual({ cache_write_tokens: null })
  expect(writes(log({ input: 1, cache: 2, write: 4, output: 3 }))).toEqual({ cache_write_tokens: 4 })
  expect(writes(runAt(db, plan, 4, 'typescript_specialist', '2026-09-27 00:00:00'))).toEqual({ cache_write_tokens: null })
  expect(() => log({ input: 1, cache: 2, write: -1, output: 3 })).toThrow(/CHECK constraint failed: cache_write_tokens/)
})
