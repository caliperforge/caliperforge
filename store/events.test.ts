import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import type { Fired } from '../providers/kind.ts'
import { planRow } from '../runner/index.ts'
import { load, seat } from '../runner/rules.ts'
import { runLogged } from './events.ts'

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
