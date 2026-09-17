import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { audit, record } from '../index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('passes when every expected done-condition carries a pointer', () => {
  const verdict = audit(fixture('handback-carried.md'), ['D1', 'D2'])
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses an expected done-condition the handback does not carry', () => {
  const verdict = audit(fixture('handback-unpointed.md'), ['D1', 'D2', 'D3'])
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D2', 'D3'])
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('completion-audit')
})

test('refuses every expected done-condition when the handback carries no fence', () => {
  const verdict = audit('Not logged in \u00b7 Please run /login', ['D1'])
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.spans).toEqual(['D1'])
})

test('writes a verdicts row the store accepts', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const id = record(db, plan, audit(fixture('handback-unpointed.md'), ['D1', 'D2']), 0.01)
  const row = db.prepare('SELECT gate, kind, outcome, rail_id, origin_kind, origin_ref, tokens FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'pre_review', kind: 'rail', outcome: 'refuse', rail_id: 'completion-audit', origin_kind: 'rail', origin_ref: 'completion-audit', tokens: 0 })
})
