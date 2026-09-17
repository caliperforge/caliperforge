import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { record, type Verdict } from '../../record.ts'
import { ready, type Proof } from '../index.ts'
import type { Db } from '../../../store/index.ts'

const root = join(import.meta.dirname, '../../..')

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

function seeded(): Db {
  const db = fresh(join(root, 'schema'))
  load(db, root)
  db.exec(fixture('accounts.sql'))
  return db
}

function ci(outcome: 'pass' | 'refuse'): Verdict {
  const refused = outcome === 'refuse'
  return {
    outcome,
    origin_kind: refused ? 'rail' : null,
    origin_ref: refused ? 'ci-green' : null,
    subject_digest: '0'.repeat(64),
    spans: refused ? ['https://github.com/o/r/actions/runs/1 ci.red'] : [],
    message: 'ci',
  }
}

function proof(name: string, outcome: 'pass' | 'refuse'): Proof {
  return { ...(JSON.parse(fixture(name)) as Omit<Proof, 'ci'>), ci: ci(outcome) }
}

test('refuses every unmet ready condition by name', () => {
  const verdict = ready(seeded(), proof('red.proof.json', 'refuse'))
  expect(verdict.outcome).toBe('refuse')
  expect(verdict.origin_kind).toBe('rail')
  expect(verdict.origin_ref).toBe('ready')
  expect(verdict.spans).toEqual([
    'tests:1 ready.tests',
    'tree:1 ready.byte_identical',
    'https://github.com/o/r/actions/runs/1 ci.red',
    'fork:1 not.public',
    'bot:1 ready.bot_clean',
    'parked-org/project:1 stale.verdict',
    'spans:1 no.anchor',
  ])
})

test('passes a green deliverable against a warm target measured inside 30 days', () => {
  const verdict = ready(seeded(), proof('green.proof.json', 'pass'))
  expect(verdict.outcome).toBe('pass')
  expect(verdict.spans).toEqual([])
})

test('refuses a green tree the counterparty bot flagged, and a fork nobody can read', () => {
  const db = seeded()
  const clean = proof('green.proof.json', 'pass')
  expect(ready(db, { ...clean, bot_clean: false }).spans).toEqual(['bot:1 ready.bot_clean'])
  expect(ready(db, { ...clean, fork_public: false }).spans).toEqual(['fork:1 not.public'])
})

test('refuses a warm row measured more than 30 days ago, and an unmeasured repo', () => {
  const db = seeded()
  const stale = ready(db, { ...proof('green.proof.json', 'pass'), repo: 'cold-org/project' })
  expect(stale.spans).toEqual(['cold-org/project:1 stale.verdict'])
  const absent = ready(db, { ...proof('green.proof.json', 'pass'), repo: 'never-org/project' })
  expect(absent.spans).toEqual(['never-org/project:1 stale.verdict'])
})

test('writes the ready verdict that lets a plan reach batch', () => {
  const db = seeded()
  const plan = planRow(db)
  const id = record(db, join(import.meta.dirname, '..'), plan, ready(db, proof('green.proof.json', 'pass')), 0.01)
  const row = db.prepare('SELECT gate, step, kind, outcome, rail_id, origin_kind FROM verdicts WHERE id = ?').get(id)
  expect(row).toEqual({ gate: 'ready', step: 6, kind: 'rail', outcome: 'pass', rail_id: 'ready', origin_kind: null })
})
