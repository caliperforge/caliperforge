import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate, open } from '../../store/index.ts'
import { terminal } from '../../store/plans.ts'
import { hold, isHeld, unhold } from '../hold.ts'
import { maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  const home = mkdtempSync(join(tmpdir(), 'cf-hold-'))
  put(home, 7, 'question.md', 'which one?\n')
  return { db, home }
}

const row = (db: ReturnType<typeof open>) => db.prepare('SELECT state, step, waits_on FROM plans WHERE id = 7').get()

test('hold then unhold', () => {
  const { db, home } = seeded()
  hold(db, home, 7, 'paused by a person', new Date('2026-09-25T19:00:00Z'))
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: null })
  expect(isHeld(home, 7)).toBe(true)
  expect(terminal(db)).not.toContain(7)
  expect(unhold(db, home, 7, 'ceo')).toBe(4)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
  expect(db.prepare("SELECT actor FROM events WHERE plan = 7 AND kind = 'return'").all()).toEqual([{ actor: 'ceo' }])
  expect(isHeld(home, 7)).toBe(false)
})

test('unhold at step 1 sets the question aside', () => {
  const { db, home } = seeded()
  db.exec('UPDATE plans SET step = 1 WHERE id = 7')
  hold(db, home, 7, 'x', new Date(), null)
  unhold(db, home, 7, 'ceo')
  expect(isHeld(home, 7)).toBe(false)
  expect(readFileSync(join(home, '.cf/work/7/question.prev.md'), 'utf8')).toBe('which one?\n')
})

test('unhold at step 1 drops a stale checkout', () => {
  const { db, home } = seeded()
  db.exec('UPDATE plans SET step = 1 WHERE id = 7')
  writeFileSync(join(srcDir(home, 7), 'old.ts'), 'x\n')
  put(home, 7, 'base.sha', `${'c'.repeat(40)}\n`)
  hold(db, home, 7, 'x', new Date(), null)
  unhold(db, home, 7, 'ceo')
  expect(existsSync(join(home, '.cf/work/7/src'))).toBe(false)
  expect(maybe(home, 7, 'base.sha')).toBeNull()
})

test('unhold past step 1 keeps the checkout', () => {
  const { db, home } = seeded()
  writeFileSync(join(srcDir(home, 7), 'built.ts'), 'x\n')
  hold(db, home, 7, 'x', new Date(), null)
  unhold(db, home, 7, 'ceo')
  expect(existsSync(join(home, '.cf/work/7/src/built.ts'))).toBe(true)
})
