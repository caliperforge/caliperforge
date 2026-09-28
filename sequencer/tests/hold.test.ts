import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { registerLanes } from '../../cli/cf-lanes.ts'
import { registerPlans, registerRetry } from '../../cli/cf-plans.ts'
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
  expect(() => cf.parse(['hold', '7', '--by', 'cto', '--as', 'coo', '--why', 'x'], { from: 'user' })).toThrow(/--by takes ceo or coo, not cto/)
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

test('cf return prints the step the plan runs next', () => {
  const { db, home } = stoppedAtCheck('repeat')
  const printed: string[] = []
  const cf = new Command()
  registerPlans(cf, { root: home, db: () => db, out: (line: string) => { printed.push(line) } })
  cf.parse(['return', '7', '--by', 'ceo'], { from: 'user' })
  expect(printed).toEqual(['plan 7 queued at step 2\n'])
})

function ran(db: ReturnType<typeof open>, home: string, args: string[]): void {
  const cf = new Command().exitOverride()
  const cli = { root: home, db: () => db, out: () => undefined }
  registerPlans(cf, cli)
  registerRetry(cf, cli)
  registerLanes(cf, cli)
  cf.parse(args, { from: 'user' })
}

const logged = (db: ReturnType<typeof open>) => db.prepare('SELECT kind, actor, message FROM events WHERE plan = 7 ORDER BY id').all()
const plan7 = (db: ReturnType<typeof open>) => db.prepare('SELECT * FROM plans WHERE id = 7').get()

const EACH = [['return', '7'], ['retry', '7'], ['release', '7'], ['park', '7'], ['unpark', '7'], ['priority', '7', '3']]

test('D1 each command without who ran it throws and writes nothing', () => {
  const { db, home } = seeded()
  db.exec("UPDATE plans SET step = 2, state = 'blocked_on_ceo' WHERE id = 7")
  const before = plan7(db)
  for (const args of EACH) expect(() => { ran(db, home, args) }).toThrow(/--by/)
  expect(() => { ran(db, home, ['hold', '7', '--by', 'ceo', '--why', 'x']) }).toThrow(/--as/)
  expect(plan7(db)).toEqual(before)
  expect(logged(db)).toEqual([])
})

test('D4 an actor outside ceo and coo is refused before any write', () => {
  const { db, home } = seeded()
  db.exec("UPDATE plans SET step = 2, state = 'blocked_on_ceo' WHERE id = 7")
  const before = plan7(db)
  for (const args of EACH) expect(() => { ran(db, home, [...args, '--by', 'cto']) }).toThrow(/--by takes ceo or coo, not cto/)
  expect(() => { ran(db, home, ['hold', '7', '--by', 'ceo', '--as', 'cto', '--why', 'x']) }).toThrow(/not cto/)
  expect(plan7(db)).toEqual(before)
  expect(isHeld(home, 7)).toBe(false)
  expect(logged(db)).toEqual([])
})

test('D2 return, unpark, retry, release and priority log the actor given', () => {
  const each = (setup: string, args: string[]) => {
    const { db, home } = seeded()
    db.exec(`UPDATE plans SET ${setup} WHERE id = 7`)
    ran(db, home, [...args, '--by', 'coo'])
    return logged(db)
  }
  const blocked = "state = 'blocked_on_ceo'"
  expect(each(blocked, ['return', '7'])).toEqual([{ kind: 'return', actor: 'coo', message: 'step 4' }])
  expect(each(blocked, ['unpark', '7'])).toEqual([{ kind: 'return', actor: 'coo', message: 'step 4' }])
  expect(each(blocked, ['retry', '7'])).toMatchObject([{ kind: 'retry', actor: 'coo' }])
  expect(each(`step = 2, ${blocked}`, ['release', '7'])).toEqual([{ kind: 'release', actor: 'coo', message: 'step 2' }])
  expect(each('priority = 1', ['priority', '7', '3'])).toEqual([{ kind: 'priority', actor: 'coo', message: 'P3' }])
})

test('D2 unpark on a repeat stop at step 3 logs a retry by the actor given', () => {
  const { db, home } = stoppedAtCheck('repeat')
  ran(db, home, ['unpark', '7', '--by', 'coo'])
  expect(logged(db)).toEqual([{ kind: 'retry', actor: 'coo', message: 'step 2' }])
})

test('D3 park and hold log who ran them and why', () => {
  const parkedBy = seeded()
  ran(parkedBy.db, parkedBy.home, ['park', '7', '--by', 'coo', '--why', 'w'])
  expect(logged(parkedBy.db)).toEqual([{ kind: 'park', actor: 'coo', message: 'w' }])
  const heldBy = seeded()
  ran(heldBy.db, heldBy.home, ['hold', '7', '--by', 'ceo', '--as', 'coo', '--why', 'w'])
  expect(logged(heldBy.db)).toEqual([{ kind: 'hold', actor: 'coo', message: 'w' }])
  expect(holding(heldBy.db)).toEqual({ held_by: 'ceo', held_why: 'w' })
})

test('unhold past step 1 keeps the checkout', () => {
  const { db, home } = seeded()
  writeFileSync(join(srcDir(home, 7), 'built.ts'), 'x\n')
  hold(db, home, 7, 'x', new Date(), null)
  unhold(db, home, 7, 'ceo')
  expect(existsSync(join(home, '.cf/work/7/src/built.ts'))).toBe(true)
})
