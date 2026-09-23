import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { branchOf } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import { add } from '../queue.ts'

const schema = join(import.meta.dirname, '../../schema')
const REPO = 'solana-foundation/pay-kit'
const URL = `https://github.com/${REPO}/issues/166`

function world(): Db {
  const db = fresh(schema)
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, ?, '2026-09-23', 2, 1, '2026-09-23', 3, 4, 'warm', 'https://github.com/solana-foundation/pay-kit')`).run(REPO)
  return db
}

const target = (db: Db, part: string): void => {
  db.prepare(`INSERT INTO targets (account_id, repo, issue_no, part, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, ?, 166, ?, 'lgalabru', 'ready', '2026-09-23', ?)`).run(REPO, part, URL)
}

test('parts share an issue', () => {
  const db = world()
  target(db, '')
  target(db, 'stablecoins')
  expect(() => { target(db, 'stablecoins') }).toThrow(/UNIQUE/)
  expect(() => { target(db, 'Stable Coins') }).toThrow(/CHECK/)
})

test('part branch', () => {
  expect(branchOf(REPO, 166, 1)).toBe('pay-kit-166-a1')
  expect(branchOf(REPO, 166, 1, 'stablecoins')).toBe('pay-kit-166-stablecoins-a1')
})

test('part needs a card', () => {
  const db = world()
  expect(() => add(db, '/tmp', REPO, URL, 'pr-path', '2026-09-23', { part: 'stablecoins' })).toThrow(/--ask/)
  expect(() => add(db, '/tmp', REPO, URL, 'pr-path', '2026-09-23', { part: 'Stable', card: '# c\n' })).toThrow(/slug/)
})
