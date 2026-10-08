import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../checks/sqlite.ts'
import { planRow } from '../runner/index.ts'
import { load } from '../runner/rules.ts'
import { logged, runAt } from './events.ts'
import { facts } from './facts.ts'
import type { Db } from './index.ts'

const root = join(import.meta.dirname, '..')

function verdict(db: Db, plan: number, gate: string, rail: string | null, outcome: string): void {
  const origin = outcome === 'refuse' ? 'rail' : null
  db.prepare(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, 0, 0)`)
    .run(gate, rail === null ? 'review' : 'rail', 'a'.repeat(64), plan, outcome, rail, origin, origin && 'x')
}

function passing(): { db: Db; plan: number } {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  verdict(db, plan, 'pre_review', 'tight', 'pass')
  verdict(db, plan, 'pre_review', 'identifiers', 'pass')
  verdict(db, plan, 'review', null, 'pass')
  verdict(db, plan, 'senior_review', null, 'pass')
  return { db, plan }
}

const PASS = ['rails', 'code_quality', 'senior', 'identifiers'].map((name) => ({ name, ok: true, says: 'pass' }))

test('D1 four passing gates and two builds', () => {
  const { db, plan } = passing()
  const run = runAt(db, plan, 2, 'typescript_specialist', '2026-09-21T00:00:00.000Z')
  for (let i = 0; i < 2; i++) {
    logged(db, { plan, kind: 'build', actor: 'typescript_specialist', outcome: 'pass', message: '', pointer: null, run })
  }
  expect(facts(db, plan)).toEqual([...PASS, { name: 'builds', ok: true, says: '2 builds' }])
})

test('D2 a refused review fails code_quality only', () => {
  const { db, plan } = passing()
  verdict(db, plan, 'review', null, 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([PASS[0], { name: 'code_quality', ok: false, says: 'refuse' }, PASS[2], PASS[3]])
})

test('D3 a refused tight fails rails, not identifiers', () => {
  const { db, plan } = passing()
  verdict(db, plan, 'pre_review', 'tight', 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([{ name: 'rails', ok: false, says: 'tight refuse' }, ...PASS.slice(1)])
  verdict(db, plan, 'pre_review', 'tight', 'pass')
  verdict(db, plan, 'pre_review', 'identifiers', 'refuse')
  expect(facts(db, plan).slice(0, 4)).toEqual([...PASS.slice(0, 3), { name: 'identifiers', ok: false, says: 'refuse' }])
})

test('D4 an empty plan has no verdict on any gate', () => {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  const plan = planRow(db)
  const none = PASS.map(({ name }) => ({ name, ok: false, says: 'no verdict' }))
  expect(facts(db, plan)).toEqual([...none, { name: 'builds', ok: true, says: '0 builds' }])
})
