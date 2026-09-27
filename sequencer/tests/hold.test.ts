import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { registerPlans } from '../../cli/cf-plans.ts'
import { migrate, open } from '../../store/index.ts'
import { held, terminal, type Holder } from '../../store/plans.ts'
import { WHY } from '../../store/refusals.ts'
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

const holding = (db: ReturnType<typeof open>) => db.prepare('SELECT held_by, held_why FROM plans WHERE id = 7').get()

test('D3 a held plan names who it waits on and why, and unhold clears both', () => {
  const { db, home } = seeded()
  hold(db, home, 7, 'after #372', new Date())
  held(db, 7, 'coo', 'after #372')
  expect(holding(db)).toEqual({ held_by: 'coo', held_why: 'after #372' })
  unhold(db, home, 7, 'ceo')
  expect(holding(db)).toEqual({ held_by: null, held_why: null })
})

test('D4 a holder outside ceo and coo is refused by the store and by cf hold before any write', () => {
  const { db, home } = seeded()
  expect(() => { held(db, 7, 'cto' as Holder, 'x') }).toThrow(/CHECK constraint/)
  expect(holding(db)).toEqual({ held_by: null, held_why: null })
  const cf = new Command()
  registerPlans(cf, { root: home, db: () => db, out: () => undefined })
  expect(() => cf.parse(['hold', '7', '--by', 'cto', '--why', 'x'], { from: 'user' })).toThrow(/--by takes ceo or coo, not cto/)
  expect(row(db)).toEqual({ state: 'running', step: 4, waits_on: null })
  expect(isHeld(home, 7)).toBe(false)
})

test('unhold at step 1 sets the question aside', () => {
  const { db, home } = seeded()
  db.exec('UPDATE plans SET step = 1 WHERE id = 7')
  hold(db, home, 7, 'x', new Date(), null)
  expect(unhold(db, home, 7, 'ceo')).toBe(1)
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

function stoppedAtCheck(why: keyof typeof WHY) {
  const seed = seeded()
  seed.db.exec("UPDATE plans SET step = 3, state = 'blocked_on_ceo' WHERE id = 7")
  put(seed.home, 7, 'refusal.md', `step 3 rails refused by pre_review\n\n…\n\n# Stopped\n\n${WHY[why]}.\n`)
  return seed
}

test('unhold on a repeat stop at step 3 sends the plan back to the build', () => {
  const { db, home } = stoppedAtCheck('repeat')
  expect(unhold(db, home, 7, 'ceo')).toBe(2)
  expect(db.prepare('SELECT step FROM plans WHERE id = 7').get()).toEqual({ step: 2 })
  expect(db.prepare('SELECT DISTINCT cleared FROM refusals WHERE plan = 7').all()).toEqual([{ cleared: 1 }])
  expect(db.prepare("SELECT actor FROM events WHERE plan = 7 AND kind = 'retry'").all()).toEqual([{ actor: 'ceo' }])
  expect(maybe(home, 7, 'refusal.md')).not.toBeNull()
})

test('unhold on an unchanged stop at step 3 returns at step 3', () => {
  const { db, home } = stoppedAtCheck('unchanged')
  expect(unhold(db, home, 7, 'ceo')).toBe(3)
})

test('unhold on a held repeat stop at step 3 returns at step 3', () => {
  const { db, home } = stoppedAtCheck('repeat')
  hold(db, home, 7, 'x', new Date(), null)
  expect(unhold(db, home, 7, 'ceo')).toBe(3)
})

test('unhold past step 1 keeps the checkout', () => {
  const { db, home } = seeded()
  writeFileSync(join(srcDir(home, 7), 'built.ts'), 'x\n')
  hold(db, home, 7, 'x', new Date(), null)
  unhold(db, home, 7, 'ceo')
  expect(existsSync(join(home, '.cf/work/7/src/built.ts'))).toBe(true)
})
