import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { expect, test } from 'vitest'
import { registerLanes } from '../../cli/cf-lanes.ts'
import { registerPlans, registerRetry } from '../../cli/cf-plans.ts'
import { all } from '../../cli/inbox.ts'
import { gates } from '../../store/approvals.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { eventsOf } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
import { drop, take } from '../../store/leases.ts'
import { addPart } from '../../store/parts.ts'
import { held, terminal, type Holder } from '../../store/plans.ts'
import { WHY } from '../../store/refusals.ts'
import { lapsed } from '../../store/until.ts'
import { released } from '../fixer.ts'
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

const LATER = new Date('2099-01-01T00:00:00Z')

test('hold then unhold', () => {
  const { db, home } = seeded()
  hold(db, home, 7, 'paused by a person', new Date('2026-09-25T19:00:00Z'), null, LATER)
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: null })
  expect(isHeld(home, 7)).toBe(true)
  expect(terminal(db)).not.toContain(7)
  expect(unhold(db, home, 7, 'ceo')).toBe(4)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
  expect(db.prepare("SELECT actor FROM events WHERE plan = 7 AND kind = 'return'").all()).toEqual([{ actor: 'ceo' }])
  expect(isHeld(home, 7)).toBe(false)
})

const holding = (db: ReturnType<typeof open>) => db.prepare('SELECT held_by, held_why FROM plans WHERE id = 7').get()

test('D3 a held plan names holder and why; unhold clears both', () => {
  const { db, home } = seeded()
  hold(db, home, 7, 'after #372', new Date(), null, LATER)
  held(db, 7, 'coo', 'after #372')
  expect(holding(db)).toEqual({ held_by: 'coo', held_why: 'after #372' })
  unhold(db, home, 7, 'ceo')
  expect(holding(db)).toEqual({ held_by: null, held_why: null })
})

test('D4 a plan hold keeps a why line; no plan keeps held_why', () => {
  const { db, home } = seeded()
  db.exec("INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (8, 9, 'pr_path', 'queued', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/140')")
  hold(db, home, 7, 'after #140\nit edits the same file', new Date(), 8)
  expect(holding(db)).toEqual({ held_by: 'coo', held_why: 'after #140' })
  held(db, 7, 'ceo', 'set before')
  hold(db, home, 7, 'paused', new Date(), null, LATER)
  expect(holding(db)).toEqual({ held_by: 'ceo', held_why: 'set before' })
})

test('D4 a holder not ceo or coo is refused by store and cf hold', () => {
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
  hold(db, home, 7, 'x', new Date(), null, LATER)
  expect(unhold(db, home, 7, 'ceo')).toBe(1)
  expect(isHeld(home, 7)).toBe(false)
  expect(readFileSync(join(home, '.cf/work/7/question.prev.md'), 'utf8')).toBe('which one?\n')
})

test('unhold at step 1 drops a stale checkout', () => {
  const { db, home } = seeded()
  db.exec('UPDATE plans SET step = 1 WHERE id = 7')
  writeFileSync(join(srcDir(home, 7), 'old.ts'), 'x\n')
  put(home, 7, 'base.sha', `${'c'.repeat(40)}\n`)
  hold(db, home, 7, 'x', new Date(), null, LATER)
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

test('unhold on a repeat stop at step 3 sends it back to build', () => {
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
  hold(db, home, 7, 'x', new Date(), null, LATER)
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

function driven() {
  const { db, home } = seeded()
  const printed: string[] = []
  const cf = new Command()
  registerPlans(cf, { root: home, db: () => db, out: (line: string) => { printed.push(line) } })
  const run = (...args: string[]) => cf.parse(args, { from: 'user' })
  const closes = () => db.prepare("SELECT actor, outcome, message FROM events WHERE kind = 'close'").all()
  return { db, printed, run, closes }
}

test('D4 cf close refuses by default, keeps its step, logs once', () => {
  const { db, printed, run, closes } = driven()
  run('close', '7', '--why', 'x', '--by', 'coo')
  expect(row(db)).toEqual({ state: 'refused', step: 4, waits_on: null })
  expect(closes()).toEqual([{ actor: 'coo', outcome: 'refuse', message: 'x' }])
  expect(printed).toEqual(['plan 7 refused\n'])
  expect(terminal(db)).toContain(7)
})

test('D4 cf close --as done finishes the plan with a pass event', () => {
  const { db, run, closes } = driven()
  run('close', '7', '--why', 'landed by hand', '--by', 'ceo', '--as', 'done')
  expect(row(db)).toEqual({ state: 'done', step: 4, waits_on: null })
  expect(closes()).toEqual([{ actor: 'ceo', outcome: 'pass', message: 'landed by hand' }])
})

test('D5 cf close and cf files on a missing plan write nothing', () => {
  const { db, printed, run } = driven()
  expect(() => run('plan', '99')).toThrow('no plan 99')
  expect(printed).toEqual([])
  expect(() => run('close', '99', '--why', 'x', '--by', 'coo')).toThrow('no plan 99')
  expect(() => run('files', '99', 'add', 'a.ts', '--by', 'coo')).toThrow('no plan 99')
  expect(db.prepare('SELECT count(*) AS n FROM plan_files WHERE plan = 99').get()).toEqual({ n: 0 })
  expect(db.prepare('SELECT count(*) AS n FROM events WHERE plan = 99').get()).toEqual({ n: 0 })
})

test('D6 bad holders, --as, closed or leased plans write nothing', () => {
  const { db, run, closes } = driven()
  expect(() => run('close', '7', '--why', 'x', '--by', 'cto')).toThrow('--by takes ceo or coo, not cto')
  expect(() => run('files', '7', 'add', 'a.ts', '--by', 'cto')).toThrow('--by takes ceo or coo, not cto')
  expect(() => run('close', '7', '--why', 'x', '--by', 'coo', '--as', 'halted')).toThrow('--as takes refused or done, not halted')
  take(db, 7)
  expect(() => run('close', '7', '--why', 'x', '--by', 'coo')).toThrow(/mid-step in a live tick/)
  expect(row(db)).toEqual({ state: 'running', step: 4, waits_on: null })
  expect(closes()).toEqual([])
  drop(db, 7)
  db.exec("UPDATE plans SET state = 'done' WHERE id = 7")
  expect(() => run('close', '7', '--why', 'x', '--by', 'coo')).toThrow('plan 7 is already done')
  expect(closes()).toEqual([])
})

test('cf files prints the edit it made', () => {
  const { printed, run } = driven()
  run('files', '7', 'add', 'a.ts', '--by', 'coo')
  expect(printed).toEqual(['plan 7 add a.ts\n'])
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

const EACH = [['return', '7'], ['retry', '7'], ['release', '7'], ['park', '7'], ['unpark', '7'], ['priority', '7', '3', '--why', 'w']]

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

test('D2 return, unpark, retry, release, priority log the actor', () => {
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
  expect(each('priority = 1', ['priority', '7', '3', '--why', 'w'])).toEqual([{ kind: 'priority', actor: 'coo', message: 'P1 → P3: w' }])
})

test('D2 unpark on a repeat step-3 stop logs the actor\'s retry', () => {
  const { db, home } = stoppedAtCheck('repeat')
  ran(db, home, ['unpark', '7', '--by', 'coo'])
  expect(logged(db)).toEqual([{ kind: 'retry', actor: 'coo', message: 'step 2' }])
})

test('D3 park and hold log who ran them and why', () => {
  const parkedBy = seeded()
  ran(parkedBy.db, parkedBy.home, ['park', '7', '--by', 'coo', '--why', 'w', '--until', '2026-10-04T22:00:00Z'])
  expect(logged(parkedBy.db)).toEqual([{ kind: 'park', actor: 'coo', message: 'w' }])
  const heldBy = seeded()
  ran(heldBy.db, heldBy.home, ['hold', '7', '--by', 'ceo', '--as', 'coo', '--why', 'w', '--until', '2026-10-04T22:00:00Z'])
  expect(logged(heldBy.db)).toEqual([{ kind: 'hold', actor: 'coo', message: 'w' }])
  expect(holding(heldBy.db)).toEqual({ held_by: 'ceo', held_why: 'w' })
})

test('holdNeedsCondition D1 D2 no time or plan writes nothing', () => {
  const { db, home } = seeded()
  const before = plan7(db)
  expect(() => { hold(db, home, 7, 'x', new Date()) }).toThrow('needs a time or a plan that releases it')
  expect(() => { ran(db, home, ['hold', '7', '--by', 'coo', '--why', 'x', '--as', 'coo']) }).toThrow('needs a time or a plan that releases it')
  expect(() => { ran(db, home, ['park', '7', '--by', 'coo']) }).toThrow('needs a time or a plan that releases it')
  expect(plan7(db)).toEqual(before)
  expect(plan7(db)).toMatchObject({ state: 'running', waits_on: null, held_until: null, held_by: null, held_why: null })
  expect(isHeld(home, 7)).toBe(false)
  expect(logged(db)).toEqual([])
})

test('D3 cf park --until holds the plan until that time', () => {
  const { db, home } = seeded()
  ran(db, home, ['park', '7', '--by', 'coo', '--until', '2026-10-04T22:00:00Z'])
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_until: '2026-10-04T22:00:00.000Z' })
  expect(logged(db)).toMatchObject([{ kind: 'park', actor: 'coo' }])
})

test('D4 cf hold --on waits on an open plan, refuses a closed one', () => {
  const { db, home } = seeded()
  db.exec("INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (8, 9, 'pr_path', 'queued', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/140')")
  ran(db, home, ['hold', '7', '--by', 'ceo', '--as', 'coo', '--why', 'w', '--on', '8'])
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', waits_on: 8, held_until: null, held_by: 'ceo', held_why: 'w' })
  ran(db, home, ['hold', '7', '--by', 'ceo', '--as', 'coo', '--why', 'w', '--on', '8', '--until', '2026-10-04T22:00:00Z'])
  expect(plan7(db)).toMatchObject({ waits_on: 8, held_until: '2026-10-04T22:00:00.000Z' })
  const shut = seeded()
  shut.db.exec("INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (8, 9, 'pr_path', 'done', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/140')")
  const before = plan7(shut.db)
  expect(() => { ran(shut.db, shut.home, ['hold', '7', '--by', 'ceo', '--as', 'coo', '--why', 'w', '--on', '8']) })
    .toThrow('plan 8 is not open, so nothing would release plan 7')
  expect(plan7(shut.db)).toEqual(before)
  expect(isHeld(shut.home, 7)).toBe(false)
  expect(logged(shut.db)).toEqual([])
})

function heldAt4() {
  const seed = seeded()
  seed.db.exec(`UPDATE plans SET state = 'blocked_on_ceo', retries = 1, head_digest = '${'a'.repeat(64)}' WHERE id = 7`)
  hold(seed.db, seed.home, 7, 'x', new Date(), null, LATER)
  return seed
}

test('D1 return --to 2 rewinds and logs the move', () => {
  const { db, home } = heldAt4()
  ran(db, home, ['return', '7', '--to', '2', '--by', 'coo'])
  expect(plan7(db)).toMatchObject({ step: 2, retries: 0, head_digest: null })
  expect(['queued', 'running']).toContain((plan7(db) as { state: string }).state)
  expect(logged(db)).toEqual([{ kind: 'return', actor: 'coo', message: 'step 4 → 2' }])
})

test('D2 D3 return --to past the step or not a step writes nothing', () => {
  const { db, home } = heldAt4()
  const before = plan7(db)
  expect(() => { ran(db, home, ['return', '7', '--to', '5', '--by', 'coo']) }).toThrow('--to takes a step from 0 to 4')
  expect(() => { ran(db, home, ['return', '7', '--to', 'x', '--by', 'coo']) }).toThrow('not NaN')
  expect(() => { ran(db, home, ['return', '7', '--to', '-1', '--by', 'coo']) }).toThrow('not -1')
  expect(plan7(db)).toEqual(before)
  expect(logged(db)).toEqual([])
  expect(isHeld(home, 7)).toBe(true)
})

test('D4 return --to on a running plan writes nothing', () => {
  const { db, home } = seeded()
  const before = plan7(db)
  expect(() => { ran(db, home, ['return', '7', '--to', '2', '--by', 'coo']) }).toThrow('is neither blocked on the ceo nor halted')
  expect(plan7(db)).toEqual(before)
  expect(logged(db)).toEqual([])
})

test('D5 return --to 1 on a repeat stop logs return, not retry', () => {
  const { db, home } = stoppedAtCheck('repeat')
  ran(db, home, ['return', '7', '--to', '1', '--by', 'coo'])
  expect(plan7(db)).toMatchObject({ step: 1 })
  expect(logged(db)).toEqual([{ kind: 'return', actor: 'coo', message: 'step 3 → 1' }])
})

const NOW = new Date('2026-10-04T22:00:00.000Z')
const returns = (db: ReturnType<typeof open>) => eventsOf(db, 7, 'return').map((e) => ({ actor: e.actor }))
const pushed = (db: ReturnType<typeof open>, plan: number) => {
  pushedRow(db, { plan, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, gates(db, plan, 'd'.repeat(64)))
}

test('holdUntil D2 D3 past time releases once, future time holds', () => {
  const later = seeded()
  hold(later.db, later.home, 7, 'recheck', NOW, null, new Date('2026-10-04T22:00:01.000Z'))
  released(later.db, later.home, NOW, () => undefined)
  expect(row(later.db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: null })
  expect(returns(later.db)).toEqual([])
  expect(all(later.home)).toEqual([])
  const { db, home } = seeded()
  hold(db, home, 7, 'recheck', NOW, null, new Date('2026-10-04T21:59:59.000Z'))
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
  expect(returns(db)).toEqual([{ actor: 'fixer' }])
  expect(all(home)).toMatchObject([{ plan: 7, kind: 'refused', name: 'fixer', note: 'held until 2026-10-04T21:59:59.000Z passed, so this job is back in its lane' }])
  db.exec("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = 7")
  expect(lapsed(db, NOW.toISOString())).toEqual([])
})

test('holdOnPlan D4 a hold on plan 8 is released when 8 lands', () => {
  const { db, home } = seeded()
  db.exec("INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (8, 9, 'pr_path', 'queued', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/140')")
  hold(db, home, 7, 'after #140', NOW, 8)
  db.exec("UPDATE plans SET state = 'done' WHERE id = 8")
  pushed(db, 8)
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
})

test('D2 D3 a hold on a done plan waits for its push', () => {
  const { db, home } = seeded()
  db.exec("INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (8, 9, 'pr_path', 'queued', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/140')")
  hold(db, home, 7, 'after #140', NOW, 8)
  db.exec("UPDATE plans SET state = 'done' WHERE id = 8")
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: 8 })
  expect(isHeld(home, 7)).toBe(true)
  expect(returns(db)).toEqual([])
  pushed(db, 8)
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
})

function waitsOnSplit() {
  const seed = seeded()
  for (const id of [8, 9, 10]) {
    seed.db.exec(`INSERT INTO plans (id, pipe_id, template, state, queued_at, lane, seat, origin) VALUES (${String(id)}, 9, 'pr_path', 'queued', '2026-09-24', 'machine', 'typescript_specialist', 'https://github.com/caliperforge/caliperforge/issues/14${String(id)}')`)
  }
  hold(seed.db, seed.home, 7, 'after #148', NOW, 8)
  seed.db.exec("UPDATE plans SET state = 'done' WHERE id = 8")
  addPart(seed.db, { parent: 8, n: 0, url: 'https://github.com/caliperforge/caliperforge/issues/149', title: '148a: x', body: 'x', plan: 9 })
  addPart(seed.db, { parent: 8, n: 1, url: 'https://github.com/caliperforge/caliperforge/issues/150', title: '148b: x', body: 'x', after: 0 })
  released(seed.db, seed.home, NOW, () => undefined)
  return seed
}

test('D1 D2 a hold on a split plan waits for every part', () => {
  const { db, home } = waitsOnSplit()
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: 8 })
  expect(returns(db)).toEqual([])
  db.exec("UPDATE plans SET state = 'done' WHERE id = 9")
  pushed(db, 9)
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: 8 })
  db.exec("UPDATE parts SET plan = 10 WHERE parent = 8 AND n = 1")
  db.exec("UPDATE plans SET state = 'done' WHERE id = 10")
  pushed(db, 10)
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'queued', step: 4, waits_on: null })
})

test('D3 a refused part of a split plan sends the hold to the COO', () => {
  const { db, home } = waitsOnSplit()
  db.exec("UPDATE parts SET plan = 10 WHERE parent = 8 AND n = 1")
  db.exec("UPDATE plans SET state = 'refused' WHERE id = 9")
  released(db, home, NOW, () => undefined)
  expect(row(db)).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: null })
  expect(holding(db)).toEqual({ held_by: 'coo', held_why: 'plan 9, which this job waits on, ended refused' })
  expect(returns(db)).toEqual([])
})

test('unhold past step 1 keeps the checkout', () => {
  const { db, home } = seeded()
  writeFileSync(join(srcDir(home, 7), 'built.ts'), 'x\n')
  hold(db, home, 7, 'x', new Date(), null, LATER)
  unhold(db, home, 7, 'ceo')
  expect(existsSync(join(home, '.cf/work/7/src/built.ts'))).toBe(true)
})
