import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decided, decisions, VERBS, type Decision } from './decisions.ts'
import { migrate, open, type Db } from './index.ts'
import { WAIT } from './plans.ts'

const root = join(import.meta.dirname, '..')

const PLAN = 1

const ROW: Decision = {
  plan: PLAN, step: 3, wait_reason: 'token_ceiling', verb: 'ask_ceo',
  why: 'the job is over its ceiling and the ticket looks bigger than one job',
  evidence: 'refusals#17', tokens: 14_820,
}

function bench(): Db {
  const db = open(':memory:')
  migrate(db, join(root, 'schema'))
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, 'pr_path', 'running', '2026-09-22T00:00:00.000Z', 'machine', 'typescript_specialist',
      'https://github.com/caliperforge/caliperforge/issues/143')`).run(PLAN)
  return db
}

test('a decision round-trips', () => {
  const db = bench()
  decided(db, ROW)
  expect(decisions(db, PLAN)).toEqual([ROW])
})

test('every verb on the menu is accepted', () => {
  const db = bench()
  for (const verb of VERBS) decided(db, { ...ROW, verb })
  expect(decisions(db, PLAN).map((d) => d.verb)).toEqual([...VERBS])
})

test('a verb off the menu is refused by the store', () => {
  const db = bench()
  expect(() => { decided(db, { ...ROW, verb: 'reassign' as never }) }).toThrow(/CHECK/)
})

test('every wait reason the tick writes is a reason the orchestrator can wake on', () => {
  const db = bench()
  for (const wait_reason of WAIT) decided(db, { ...ROW, wait_reason })
  expect(decisions(db, PLAN)).toHaveLength(WAIT.length)
})

test('a why that is blank, and an unknown wait reason, are refused', () => {
  const db = bench()
  expect(() => { decided(db, { ...ROW, why: '   ' }) }).toThrow(/CHECK/)
  expect(() => { decided(db, { ...ROW, wait_reason: 'bored' as never }) }).toThrow(/CHECK/)
})

test('a decision with no evidence keeps its null', () => {
  const db = bench()
  decided(db, { ...ROW, evidence: null, tokens: 0 })
  expect(decisions(db, PLAN)[0]).toMatchObject({ evidence: null, tokens: 0 })
})
