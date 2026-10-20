import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { branchOf } from '../../sequencer/workspace.ts'
import type { Db } from '../../store/index.ts'
import { addAccount, putTarget } from '../../store/targets.ts'
import { add } from '../queue.ts'

const schema = join(import.meta.dirname, '../../schema')
const REPO = 'solana-foundation/pay-kit'
const URL = `https://github.com/${REPO}/issues/166`

function world(): Db {
  const db = fresh(schema)
  addAccount(db, { id: 1, repo: REPO, measured_at: '2026-09-23', maintainers: 2, doors: 1, last_outsider_merge: '2026-09-23',
    open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'warm', evidence: 'https://github.com/solana-foundation/pay-kit' })
  return db
}

const target = (db: Db, part: string): void => {
  putTarget(db, { account_id: 1, repo: REPO, issue_no: 166, part, named_merger: 'lgalabru', state: 'ready',
    evidence_measured_at: '2026-09-23', evidence: URL })
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
