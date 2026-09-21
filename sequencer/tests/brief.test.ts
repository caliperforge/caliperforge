import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'
import { walk } from '../../checks/tree.ts'
import type { Packet } from '../../providers/kind.ts'
import { release } from '../../store/holds.ts'
import { get } from '../../store/lanes.ts'
import { files, shape, unclear } from '../brief.ts'
import { tick } from '../index.ts'
import { blocked } from '../steps.ts'
import { drop, maybe, move, put, titleOf } from '../workspace.ts'
import { approve, CARRIED, internalPlan, ours, plan, reads, stub, world, type World } from './world.ts'

const repo = join(import.meta.dirname, '../..')

const fixture = (name: string): string => readFileSync(join(repo, 'seats/brief_writer/tests', name), 'utf8')

const ask = fixture('ask.md')

const ID = 2

const briefOf = (w: World): string => maybe(w.root, ID, 'issue.md') ?? ''

const askOf = (w: World): string => maybe(w.root, ID, 'ask.md') ?? ''

const left = (w: World): string => get(w.db, 'brief.reads_left')

const listed = (w: World): unknown[] =>
  w.db.prepare('SELECT path FROM plan_files WHERE plan = ? ORDER BY position').all(ID)

const STOP = `CREATE TRIGGER stop BEFORE UPDATE OF step ON plans WHEN NEW.step = 2
  BEGIN SELECT RAISE(ABORT, 'advance refused'); END`

/** A fixture reply retitled onto the ask the internal plan is filed with, which every brief's title must equal. */
const titled = (name: string): string => fixture(name).replace('# A seat that briefs before any build', '# let an internal plan run')

/** The reply a seat that cannot brief the ask ends with, in place of a brief. */
const asks = (question: string): string => `---\noutcome: unclear\nquestion: ${question}\n---\n`

function mine(): World {
  const w = world()
  w.db.prepare('DELETE FROM plans WHERE id = 1').run()
  ours(w.root)
  internalPlan(w.db, w.root, ID)
  return w
}

test('a brief with every part, two D rows and files in the checkout passes', () => {
  expect(shape(fixture('brief.md'), ask, repo)).toBeNull()
})

test('the part that is missing is the span, and a path off the checkout is its own', () => {
  expect(shape(fixture('no-must-not-break.md'), ask, repo)).toBe('## Must not break')
  expect(shape(fixture('one-case.md'), ask, repo)).toBe('## Cases')
  expect(shape(fixture('absent-file.md'), ask, repo)).toBe('sequencer/nowhere.ts')
})

test('a title the ask does not carry, a dropped line, a part out of order and 60 lines passed are refused', () => {
  const brief = fixture('brief.md')
  expect(shape(brief.replace('# A seat', '# Some seat'), ask, repo)).toBe('# <title>')
  expect(shape(brief.replace('# A seat that briefs before any build\n', ''), ask, repo)).toBe('# <title>')
  expect(shape(brief.replace(/^\*\*Why:.*$/m, ''), ask, repo)).toBe('**Why:**')
  expect(shape('# A seat that briefs before any build\n\n**What:** one\n**Why:** two\n**When it ends:** three\n'
    + '\n## Cases\n\n- D1 one\n- D2 two\n\n## Approach\n', ask, repo)).toBe('## Cases')
  expect(shape(`${brief}${'\n- a line'.repeat(40)}`, ask, repo)).toBe('60 lines')
})

test('only a fence that says unclear carries a question back to the COO', () => {
  expect(unclear(fixture('unclear.md'))).toBe('is the GitHub comment part of this change or its own issue?')
  expect(unclear(fixture('brief.md'))).toBeNull()
  expect(unclear('---\noutcome: unclear\n---\n')).toBeNull()
})

test('step 1 fires the read-only seat once, saves its reply as the brief, and advances to the build', async () => {
  const w = mine()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))
  expect(titleOf(w.root, ID)).toBe('let an internal plan run')
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => packets.push(p))))[0]

  expect(fired).toMatchObject({ step: 1, name: 'ruling', outcome: 'pass' })
  expect(packets.map((p) => p.tools)).toEqual([['Read', 'Glob', 'Grep']])
  expect(packets[0]?.refuse('src/hello.ts')).toMatchObject({ origin_ref: 'seat.write_paths' })
  expect(shape(briefOf(w), askOf(w), repo)).toBeNull()
  expect(titleOf(w.root, ID)).toBe('let an internal plan run')
  expect(w.db.prepare('SELECT seat, exit FROM runs WHERE step = 1').get()).toEqual({ seat: 'brief_writer', exit: 0 })
  expect(plan(w.db, ID).step).toBe(2)
})

test('a throw at the advance takes the file list back with it', async () => {
  const w = mine()
  await tick(w.db, w.root, stub(CARRIED))
  w.db.exec(STOP)

  await expect(tick(w.db, w.root, stub(CARRIED))).rejects.toThrow(/advance refused/)
  expect(plan(w.db, ID).step).toBe(1)
  expect(listed(w)).toEqual([])

  w.db.exec('DROP TRIGGER stop')
  await tick(w.db, w.root, stub(CARRIED))
  expect(plan(w.db, ID).step).toBe(2)
  expect(listed(w)).toEqual([{ path: 'src/hello.ts' }])
})

const FAILS = [
  ['no-must-not-break.md', '## Must not break'],
  ['one-case.md', '## Cases'],
  ['absent-file.md', 'sequencer/nowhere.ts'],
] as const

test('a reply that fails the shape check refuses step 1 on the missing part and writes no brief', async () => {
  for (const [name, span] of FAILS) {
    const w = mine()
    await tick(w.db, w.root, stub(CARRIED))
    const fired = (await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, titled(name))))[0]
    expect(fired).toMatchObject({ step: 1, outcome: 'refuse', state: 'retried', spans: [span] })
    expect(maybe(w.root, ID, 'issue.md')).toBeNull()
  }
})

/** A world whose first brief was turned back on its shape, parked on the step 0 the refusal rewound to. */
async function turnedBack(): Promise<World> {
  const w = mine()
  await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, titled('no-must-not-break.md')))
  return w
}

test('the seat is fired again with the shape refusal under the ask', async () => {
  const w = await turnedBack()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))

  await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => packets.push(p)))
  expect(packets[0]?.prompt).toContain('# Refused — write the whole brief again, fixing this')
  expect(packets[0]?.prompt).toContain('the brief is missing ## Must not break')
  expect(shape(briefOf(w), askOf(w), repo)).toBeNull()
})

test('a brief saved after a shape refusal leaves the builder no refusal to read', async () => {
  const w = await turnedBack()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED))
  expect(maybe(w.root, ID, 'refusal.md')).toBeNull()

  expect((await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => packets.push(p))))[0])
    .toMatchObject({ step: 2, outcome: 'pass' })
  expect(packets[0]?.prompt).not.toContain('# Refused')
})

test('an unclear reply stops the plan on the COO, saves the question, and spends no retry', async () => {
  const w = mine()
  const question = 'is the comment on the issue part of this change?'
  await tick(w.db, w.root, stub(CARRIED))
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, asks(question))))[0]

  expect(fired).toMatchObject({ step: 1, outcome: 'needs_ceo', state: 'blocked_on_ceo' })
  expect(maybe(w.root, ID, 'question.md')).toBe(`${question}\n`)
  expect(maybe(w.root, ID, 'issue.md')).toBeNull()
  expect(plan(w.db, ID)).toMatchObject({ step: 1, retries: 0 })
})

test('a round that comes back to step 1 keeps the brief the reviewers read', async () => {
  const w = mine()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  const brief = briefOf(w)
  w.db.prepare("UPDATE plans SET step = 1, state = 'running' WHERE id = ?").run(ID)

  const again = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(again).toMatchObject({ step: 1, outcome: 'pass', note: 'the brief stands' })
  expect(briefOf(w)).toBe(brief)
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE step = 1').get()).toEqual({ n: 1 })
})

test('a plan a builder has run on keeps its hand-written ticket, its ask and its refusal through a rewind', async () => {
  const w = mine()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED, 1))
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'running' })
  w.db.prepare("UPDATE plans SET step = 1 WHERE id = ?").run(ID)
  const hand = '# a ticket the COO wrote\n\n- D1 do the thing\n'
  put(w.root, ID, 'issue.md', hand)
  drop(w.root, ID, 'ask.md')
  expect(maybe(w.root, ID, 'refusal.md')).toContain('step 2')

  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass', note: 'the brief stands' })
  expect(maybe(w.root, ID, 'issue.md')).toBe(hand)
  expect(maybe(w.root, ID, 'ask.md')).toBeNull()
  expect(maybe(w.root, ID, 'refusal.md')).toContain('step 2')
  expect(w.db.prepare('SELECT count(*) AS n FROM runs WHERE step = 1').get()).toEqual({ n: 1 })
})

test('a plan queued before the brief seat has its raw issue moved to the ask and is briefed like any other', async () => {
  const w = mine()
  const raw = move(w.root, ID, 'ask.md', 'issue.md')
  await tick(w.db, w.root, stub(CARRIED))
  expect(titleOf(w.root, ID)).toBe('let an internal plan run')

  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, ID, 'ask.md')).toBe(raw)
  expect(shape(briefOf(w), raw, repo)).toBeNull()
})

/** A world whose ten reads are unspent, ticked through step 0 to the tick that passes step 1. */
async function unread(): Promise<World> {
  const w = mine()
  reads(w.db, 10)
  await tick(w.db, w.root, stub(CARRIED))
  return w
}

test('the first briefed plan waits on the coo at step 2, spends one read, and the next tick fires nothing', async () => {
  const w = await unread()

  expect((await tick(w.db, w.root, stub(CARRIED)))[0])
    .toMatchObject({ step: 1, outcome: 'pass', state: 'blocked_on_ceo' })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'blocked_on_ceo' })
  expect(left(w)).toBe('9')
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
})

test('released, the plan runs again and the next tick fires the builder', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED))

  release(w.db, ID)
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'running' })
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
})

test('release refuses a plan parked on the coo at step 1 and moves no row', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, asks('is the comment part of this change?')))
  expect(plan(w.db, ID)).toMatchObject({ step: 1, state: 'blocked_on_ceo' })

  expect(() => { release(w.db, ID) }).toThrow(/plan 2 is not a brief/)
  expect(plan(w.db, ID)).toMatchObject({ step: 1, state: 'blocked_on_ceo' })
  expect(left(w)).toBe('10')
})

test('with the reads spent, step 1 passes to running and the builder fires in the next tick', async () => {
  const w = mine()
  await tick(w.db, w.root, stub(CARRIED))

  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass', state: 'running' })
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 2, outcome: 'pass' })
  expect(left(w)).toBe('0')
})

test('a rewind onto a brief that stands holds nothing and spends no read', async () => {
  const w = mine()
  for (let at = 0; at < 3; at += 1) await tick(w.db, w.root, stub(CARRIED))
  reads(w.db, 10)
  w.db.prepare("UPDATE plans SET step = 1, state = 'running' WHERE id = ?").run(ID)

  expect((await tick(w.db, w.root, stub(CARRIED)))[0])
    .toMatchObject({ step: 1, note: 'the brief stands', state: 'running' })
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'running' })
  expect(left(w)).toBe('10')
})

test('an external plan walks the same step 1 on the same seat, and never before cf approve target', async () => {
  const w = world()
  await tick(w.db, w.root, stub(CARRIED))
  expect(blocked(w.db, plan(w.db, 1))).toMatch(/awaiting cf approve target/)
  expect(await tick(w.db, w.root, stub(CARRIED))).toEqual([])
  expect(w.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 })

  approve(w.db, w.target)
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass' })
  expect(w.db.prepare('SELECT seat FROM runs WHERE step = 1').get()).toEqual({ seat: 'brief_writer' })
})

test('brief.ts is the only source that reads ## Files, and the shape check refuses through it', () => {
  const readers = walk(repo, (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((f) => relative(repo, f))
    // A live checkout carries `.cf/work/*/src`, each a copy of this tree rather than a second reader in it.
    .filter((f) => !f.startsWith('.cf/') && !f.includes('/tests/') && readFileSync(join(repo, f), 'utf8').includes('## Files'))
  expect(readers).toEqual(['sequencer/brief.ts'])

  const brief = fixture('absent-file.md')
  expect(files(brief).map((f) => f.path)).toEqual([shape(brief, ask, repo)])
})

test('a Files row naming several paths lists each once', () => {
  const brief = ['# t', '', '## Files', '', '- `a/b.rb:197`', '- Tests: `x/y_test.rb:187`, `x/z_spec.lua:149` and `a/b.rb`',
    '- `Store::TTL` moves to `c/d.rb` (new)', '', '## Out of scope', ''].join('\n')
  expect(files(brief)).toEqual([
    { path: 'a/b.rb', is_new: false }, { path: 'x/y_test.rb', is_new: false },
    { path: 'x/z_spec.lua', is_new: false }, { path: 'c/d.rb', is_new: true },
  ])
})
