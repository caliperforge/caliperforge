import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { load } from '../runner/rules.ts'
import type { Db } from './index.ts'
import { backfill } from './transcript.ts'

const root = join(import.meta.dirname, '..')
const loaded = (): Db => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  return db
}
const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', `${name}.transcript.jsonl`)

function run(db: Db, transcript: string, spent: number | null): number {
  const row = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_tokens, output_tokens, seconds, exit, transcript_path, cost_usd)
    VALUES (?, 2, 'typescript_specialist', ?, 'claude-agent-sdk', 'm', 'high', 0, 0, 0, 0, 0, ?, ?)`)
    .run(planRow(db), 'a'.repeat(64), transcript, spent)
  return Number(row.lastInsertRowid)
}

const spent = (db: Db, id: number): unknown => (db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(id) as { cost_usd: unknown }).cost_usd

test('backfill fills NULL costs once and never overwrites', () => {
  const db = loaded()
  const empty = run(db, fixture('costed'), null)
  const set = run(db, fixture('costed'), 2.96)
  expect(backfill(db)).toBe(1)
  expect(spent(db, empty)).toBe(0.43)
  expect(spent(db, set)).toBe(2.96)
  expect(backfill(db)).toBe(0)
  expect([spent(db, empty), spent(db, set)]).toEqual([0.43, 2.96])
})

test('a missing, uncosted or cut transcript stays NULL', () => {
  const db = loaded()
  const missing = run(db, fixture('absent'), null)
  const uncosted = run(db, fixture('uncosted'), null)
  expect(backfill(db)).toBe(0)
  expect([spent(db, missing), spent(db, uncosted)]).toEqual([null, null])
})
