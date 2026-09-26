import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'
import { walk } from '../../checks/tree.ts'
import type { Packet } from '../../providers/kind.ts'
import { release, retried, returnToLane } from '../../store/holds.ts'
import { get, priority } from '../../store/lanes.ts'
import { retry } from '../../store/plans.ts'
import { WHY } from '../../store/refusals.ts'
import { files, pointed, references, shape, split, TEMPLATE, unclear, writable, type Refused } from '../brief.ts'
import { tick } from '../index.ts'
import { blocked } from '../steps.ts'
import { afresh, drop, maybe, move, put, srcDir, titleOf } from '../workspace.ts'
import { approve, CARRIED, internalPlan, ours, plan, reads, stub, world, type World } from './world.ts'

const repo = join(import.meta.dirname, '../..')

const fixture = (name: string): string => readFileSync(join(repo, 'seats/brief_writer/tests', name), 'utf8')

const ask = fixture('ask.md')

const brief = fixture('brief.md')

const ID = 2

const briefOf = (w: World): string => maybe(w.root, ID, 'issue.md') ?? ''

const askOf = (w: World): string => maybe(w.root, ID, 'ask.md') ?? ''

const left = (w: World): string => get(w.db, 'brief.reads_left')

const hands = (w: World): unknown[] => w.db.prepare(`SELECT kind, actor, outcome FROM events
  WHERE kind IN ('release', 'return', 'retry', 'priority') ORDER BY id`).all()

const listed = (w: World): unknown[] =>
  w.db.prepare('SELECT path FROM plan_files WHERE plan = ? ORDER BY position').all(ID)

const STOP = `CREATE TRIGGER stop BEFORE UPDATE OF step ON plans WHEN NEW.step = 2
  BEGIN SELECT RAISE(ABORT, 'advance refused'); END`

const on = (text: string): Refused | null => shape(text, ask, repo)

const holding = (text: string): string => expect.stringContaining(text) as string

/** The fixture with one section's bullets swapped for the lines given. */
const swap = (text: string, heading: string, lines: string[]): string =>
  text.replace(new RegExp(`(${heading}\n\n)[^#]*`), `$1${lines.join('\n')}\n\n`)

/** The fixture carrying one more line under `## Out of scope`, which the grounds read like any other. */
const saying = (line: string): string => brief.replace('- posting', `${line}\n- posting`)

const handback = (changing: string[], others: string[]): string =>
  swap(swap(brief, '## Files', ['- rails/completion-audit/index.ts', ...changing]),
    '## Who else reads what this changes', others)

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

test('a brief on the template with every section filled passes', () => {
  expect(on(brief)).toBeNull()
})

test('an empty section, a path off the tree and a `(new)` path already in it are each refused', () => {
  expect(on(swap(brief, '## Out of scope', []))).toMatchObject({ span: '## Out of scope' })
  expect(on(fixture('absent-file.md'))).toMatchObject({ span: 'sequencer/nowhere.ts' })
  expect(on(swap(brief, '## Files', ['- sequencer/brief.ts (new)'])))
    .toMatchObject({ span: 'sequencer/brief.ts', reason: holding('already in the tree') })
})

test('a forced push, a squash, a person and an address are refused; CaliperForge and a repo are not', () => {
  expect(on(saying('- force push the branch once the base moves'))).toMatchObject({ span: 'force push' })
  expect(on(saying('- squash the two commits into one'))).toMatchObject({ span: 'squash' })
  expect(on(saying('- keep the row Sam Hartley signed off'))).toMatchObject({ span: 'Sam Hartley' })
  expect(on(saying('- mail coo@example.com when it lands'))).toMatchObject({ span: 'coo@example.com' })
  expect(on(saying('- CaliperForge keeps the caliperforge/widget fork'))).toBeNull()
})

test('a line forbidding a forced push, or naming `squash` as code, is not an ask to force push', () => {
  expect(on(saying('- no send carries a `+` refspec or `--force`, and it never force pushes'))).toBeNull()
  expect(on(saying('- a plan with no open PR still goes through `squash` and `renamed`'))).toBeNull()
  expect(on(saying('- force push the branch, not a merge'))).toMatchObject({ span: 'force push' })
})

test('a brief asking the builder to run, count or report anything needing a shell is refused', () => {
  const shell = 'the builder holds no shell'
  expect(on(saying('- run the tests in the checkout'))).toMatchObject({ span: 'run the tests' })
  expect(on(saying('- run the tests in the checkout'))?.reason).toContain(shell)
  expect(on(saying('- count what npm test writes'))?.reason).toContain(shell)
  expect(on(saying('- report the git log for the branch'))?.reason).toContain(shell)
})

test('shell: code that runs a command is not an ask', () => {
  expect(on(saying('- the ready gate runs git add in the parent repo when src is missing'))).toBeNull()
  expect(on(saying('- step 3 re-runs the whole command once on a timeout'))).toBeNull()
  expect(on(saying('- the builder runs the tests before it hands back'))?.reason).toContain('the builder holds no shell')
  expect(on(saying('1. Then run npm test'))?.reason).toContain('the builder holds no shell')
})

test('a brief over the line ceiling is refused on the cap', () => {
  expect(on(saying(Array.from({ length: 60 }, () => '- a line').join('\n')))).toMatchObject({ span: '100 lines' })
})

test('a change to the handback format names both its readers or is refused on the one left out', () => {
  const unaffected = ['- sequencer/workspace.ts:44 — reads the D rows, unaffected']
  expect(on(handback([], unaffected))).toMatchObject({ span: 'sequencer/rails.ts' })
  expect(on(handback(['- sequencer/rails.ts'], unaffected)))
    .toMatchObject({ span: 'rails/tight/prose.ts', reason: holding('the handback format') })
  expect(on(handback([], ['- sequencer/rails.ts — reads it', '- rails/tight/prose.ts — reads it']))).toBeNull()
})

test('the handback format beside a path that is neither its reader nor a test is two jobs in one', () => {
  const readers = ['- sequencer/rails.ts', '- rails/tight/prose.ts']
  expect(on(handback([...readers, '- store/plans.ts'], ['- nothing else'])))
    .toMatchObject({ span: 'store/plans.ts', reason: holding('two jobs in one brief') })
  expect(on(handback([...readers, '- sequencer/tests/brief.test.ts'], ['- nothing else']))).toBeNull()
})

test('the part that is missing is the span, and a section with one D row is its own', () => {
  expect(on(fixture('no-must-not-break.md'))).toMatchObject({ span: '## Must not break' })
  expect(on(fixture('one-case.md'))).toMatchObject({ span: '## Cases' })
})

test('a title the ask does not carry, a dropped line and a part out of order are refused', () => {
  expect(on(brief.replace('# A seat', '# Some seat'))).toMatchObject({ span: '# <title>' })
  expect(on(brief.replace('# A seat that briefs before any build\n', ''))).toMatchObject({ span: '# <title>' })
  expect(on(brief.replace(/^\*\*Why:.*$/m, ''))).toMatchObject({ span: '**Why:**' })
  const flipped = brief.replace('## Tests', '## X').replace('## Out of scope', '## Tests').replace('## X', '## Out of scope')
  expect(on(flipped)).toMatchObject({ span: '## Out of scope' })
})

test('only a fence that says unclear carries a question back to the COO', () => {
  expect(unclear(fixture('unclear.md'))).toBe('is the GitHub comment part of this change or its own issue?')
  expect(unclear(brief)).toBeNull()
  expect(unclear('---\noutcome: unclear\n---\n')).toBeNull()
})

test('a question naming an issue keeps everything after the #', () => {
  expect(unclear(asks('Has #3a landed, and on which commit?'))).toBe('Has #3a landed, and on which commit?')
})

test('prose with no title or fence is the question itself; a titled brief is not', () => {
  expect(unclear('I could not brief this: the router it needs is not on main.\n')).toBe('I could not brief this: the router it needs is not on main.')
  expect(unclear(brief)).toBeNull()
  expect(unclear('')).toBeNull()
})

test('a fence wrapped in a code block still splits', () => {
  const parts = '---\noutcome: split\nparts:\n  - title: a\n    what: w\n    why: y\n    ends: e\n  - title: b\n    what: w\n    why: y\n    ends: e\n---'
  expect(split(`Two jobs.\n\n\`\`\`yaml\n${parts}\n\`\`\`\n`)?.map((p) => p.title)).toEqual(['a', 'b'])
  expect(split(`Two jobs.\n\n${parts}\n`)?.map((p) => p.title)).toEqual(['a', 'b'])
  expect(unclear(`Two jobs.\n\n\`\`\`\n${parts}\n\`\`\``)).toBeNull()
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
  expect(shape(briefOf(w), askOf(w), srcDir(w.root, ID))).toBeNull()
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

test('the seat packet carries the template under the ask', async () => {
  const w = mine()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => packets.push(p)))

  const prompt = packets[0]?.prompt ?? ''
  expect(prompt).toContain(TEMPLATE)
  expect(prompt.indexOf(TEMPLATE)).toBeGreaterThan(prompt.indexOf('# let an internal plan run'))
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
    expect(w.db.prepare('SELECT title FROM plans WHERE id = ?').get(ID)).toEqual({ title: null })
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
  expect(packets[0]?.prompt).toContain('## Must not break is missing or out of order')
  expect(shape(briefOf(w), askOf(w), srcDir(w.root, ID))).toBeNull()
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
  const saved = briefOf(w)
  w.db.prepare("UPDATE plans SET step = 1, state = 'running' WHERE id = ?").run(ID)

  const again = (await tick(w.db, w.root, stub(CARRIED)))[0]
  expect(again).toMatchObject({ step: 1, outcome: 'pass', note: 'the brief stands' })
  expect(briefOf(w)).toBe(saved)
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

const STOPPED = `step 1 brief refused\n\n# Stopped\n\n${WHY.shared}.\n`

test('afresh at step 1 moves the refusal and the question aside, byte for byte', () => {
  const w = mine()
  put(w.root, ID, 'refusal.md', STOPPED)
  put(w.root, ID, 'question.md', 'which file?\n')

  afresh(w.root, ID, 1)
  expect([maybe(w.root, ID, 'refusal.md'), maybe(w.root, ID, 'question.md')]).toEqual([null, null])
  expect(maybe(w.root, ID, 'refusal.prev.md')).toBe(STOPPED)
  expect(maybe(w.root, ID, 'question.prev.md')).toBe('which file?\n')
})

test('afresh at step 2 leaves the refusal the builder reads', () => {
  const w = mine()
  put(w.root, ID, 'refusal.md', STOPPED)

  afresh(w.root, ID, 2)
  expect(maybe(w.root, ID, 'refusal.md')).toBe(STOPPED)
  expect(maybe(w.root, ID, 'refusal.prev.md')).toBeNull()
})

test('afresh on a plan with neither file writes nothing', () => {
  const w = mine()

  expect(() => { afresh(w.root, ID, 1) }).not.toThrow()
  expect([maybe(w.root, ID, 'refusal.prev.md'), maybe(w.root, ID, 'question.prev.md')]).toEqual([null, null])
})

test('a plan blocked at step 1 and retried is briefed from the ask alone', async () => {
  const w = mine()
  const packets: Packet[] = []
  await tick(w.db, w.root, stub(CARRIED))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, asks('is the comment part of this change?')))
  put(w.root, ID, 'refusal.md', STOPPED)

  afresh(w.root, ID, retry(w.db, plan(w.db, ID)))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, (p) => packets.push(p)))
  expect(packets[0]?.prompt).not.toContain('# Refused')
  expect(packets[0]?.prompt).not.toContain('lane is off')
  expect(shape(briefOf(w), askOf(w), srcDir(w.root, ID))).toBeNull()
})

test('a plan re-briefed after a retry at step 1 replaces its file list', async () => {
  const w = mine()
  for (let at = 0; at < 2; at += 1) await tick(w.db, w.root, stub(CARRIED))
  expect(listed(w)).toEqual([{ path: 'src/hello.ts' }])
  const first = briefOf(w)
  w.db.prepare("UPDATE plans SET step = 1, state = 'blocked_on_ceo' WHERE id = ?").run(ID)
  drop(w.root, ID, 'issue.md')
  afresh(w.root, ID, retry(w.db, plan(w.db, ID)))

  const second = swap(swap(first, '## Files', ['- src/bye.ts (new)']), '## Tests', ['- src/bye.ts — a call with no name is refused'])
  const fired = (await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, second)))[0]
  expect(fired).toMatchObject({ step: 1, outcome: 'pass' })
  expect(fired).not.toMatchObject({ note: 'the brief stands' })
  expect(listed(w)).toEqual([{ path: 'src/bye.ts' }])
})

test('a plan queued before the brief seat has its raw issue moved to the ask and is briefed like any other', async () => {
  const w = mine()
  const raw = move(w.root, ID, 'ask.md', 'issue.md')
  await tick(w.db, w.root, stub(CARRIED))
  expect(titleOf(w.root, ID)).toBe('let an internal plan run')

  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 1, outcome: 'pass' })
  expect(maybe(w.root, ID, 'ask.md')).toBe(raw)
  expect(shape(briefOf(w), raw, srcDir(w.root, ID))).toBeNull()
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

test('released, the plan is queued at step 2 and the next tick fires the builder', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED))

  release(w.db, ID)
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'queued' })
  expect((await tick(w.db, w.root, stub(CARRIED)))[0]).toMatchObject({ step: 2, name: 'build', outcome: 'pass' })
})

test('cf return queues a blocked or halted plan at the step it holds, and refuses any other state', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED))

  expect(returnToLane(w.db, ID)).toBe(2)
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'queued' })
  const before = hands(w)
  for (const state of ['queued', 'running', 'done', 'refused'] as const) {
    w.db.prepare('UPDATE plans SET state = ? WHERE id = ?').run(state, ID)
    expect(() => { returnToLane(w.db, ID) }).toThrow(/plan 2 is neither blocked on the ceo nor halted/)
    expect(plan(w.db, ID)).toMatchObject({ step: 2, state })
  }
  expect(hands(w)).toEqual(before)
  w.db.prepare("UPDATE plans SET state = 'halted' WHERE id = ?").run(ID)
  returnToLane(w.db, ID)
  expect(plan(w.db, ID)).toMatchObject({ step: 2, state: 'queued' })
})

test('release refuses a plan parked on the coo at step 1 and moves no row', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, asks('is the comment part of this change?')))
  expect(plan(w.db, ID)).toMatchObject({ step: 1, state: 'blocked_on_ceo' })

  expect(() => { release(w.db, ID) }).toThrow(/plan 2 is not a brief/)
  expect(plan(w.db, ID)).toMatchObject({ step: 1, state: 'blocked_on_ceo' })
  expect(left(w)).toBe('10')
  expect(hands(w)).toEqual([])
})

test('release, return, retry and priority by hand each write one event naming who did it', async () => {
  const w = await unread()
  await tick(w.db, w.root, stub(CARRIED))
  const park = (): void => { w.db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(ID) }

  release(w.db, ID)
  park()
  returnToLane(w.db, ID, 'ceo')
  park()
  retried(w.db, ID, 'ceo')
  priority(w.db, ID, 3, 'ceo')
  expect(hands(w)).toEqual([
    { kind: 'release', actor: 'coo', outcome: 'pass' },
    { kind: 'return', actor: 'ceo', outcome: 'pass' },
    { kind: 'retry', actor: 'ceo', outcome: 'pass' },
    { kind: 'priority', actor: 'ceo', outcome: 'pass' },
  ])
})

test('a refused retry or priority, and a priority with no actor, write no event', () => {
  const w = mine()
  w.db.prepare("UPDATE plans SET state = 'queued' WHERE id = ?").run(ID)

  expect(() => retried(w.db, ID, 'ceo')).toThrow(/plan 2 is queued, not blocked/)
  expect(() => { priority(w.db, ID, 10, 'ceo') }).toThrow(/cf priority takes P0 to P9/)
  priority(w.db, ID, 3)
  expect(hands(w)).toEqual([])
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
  expect(blocked(w.db, plan(w.db, 1))).toBe('target_approval')
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
  expect(files(brief).map((f) => f.path)).toEqual([shape(brief, ask, repo)?.span])
})

test('a Files row naming several paths lists each once', () => {
  const brief = ['# t', '', '## Files', '', '- `a/b.rb:197`', '- Tests: `x/y_test.rb:187`, `x/z_spec.lua:149` and `a/b.rb`',
    '- `Store::TTL` moves to `c/d.rb` (new)', '', '## Out of scope', ''].join('\n')
  expect(files(brief)).toEqual([
    { path: 'a/b.rb', is_new: false }, { path: 'x/y_test.rb', is_new: false },
    { path: 'x/z_spec.lua', is_new: false }, { path: 'c/d.rb', is_new: true },
  ])
})

test('references are the Must not break lines outside the files the job changes', () => {
  const brief = ['# t', '', '## Must not break', '', '- empty RPC URL is unset (`python/src/solana_pay_kit/config.py:12`)',
    '- booleans stay `true`/`false` (`ruby/lib/pay_kit/config.rb:40`)', '', '## Files', '', '- `ruby/lib/pay_kit/config.rb:259`', ''].join('\n')
  expect(references(brief)).toEqual([{ path: 'python/src/solana_pay_kit/config.py', line: 12 }])
})

test('a test named only under ## Tests is writable', () => {
  const brief = ['# t', '', '## Files', '', '- `ruby/lib/pay_kit/config.rb:259`', '', '## Tests', '',
    '- `ruby/test/pay_kit/config_test.rb` — D1', '- `ruby/test/pay_kit/config_test.rb` — D2', '', '## Out of scope', ''].join('\n')
  expect(writable(brief)).toEqual([
    { path: 'ruby/lib/pay_kit/config.rb', is_new: false }, { path: 'ruby/test/pay_kit/config_test.rb', is_new: true },
  ])
})

test('a folder row under ## Files is refused', () => {
  expect(on(swap(brief, '## Files', ['- sequencer/brief.ts', '- sequencer/tests/ — the tests'])))
    .toMatchObject({ span: '- sequencer/tests/ — the tests', reason: holding('names no file') })
})

const PLUS = 'Sources/App/DashboardSource+Runs.swift'

const plus = (row: string): string => ['# t', '', '## Files', '', row, '', '## Out of scope', ''].join('\n')

test('a Files row naming a + path yields that path, backticked or bare', () => {
  for (const row of [`- \`${PLUS}:27\``, `- ${PLUS}:27 — the WHERE`]) {
    expect(files(plus(row))).toEqual([{ path: PLUS, is_new: false }])
  }
})

test('a backticked + path keeps the line it points at', () => {
  expect(pointed(plus(`- \`${PLUS}:27\``))).toEqual([{ path: PLUS, line: 27 }])
})

test('a + path off the tree is refused on the whole path', () => {
  expect(on(swap(brief, '## Files', [`- \`${PLUS}:27\``])))
    .toMatchObject({ span: PLUS, reason: holding('not in the checkout') })
})

test('a brief without ## Settled facts is refused', () => {
  expect(on(brief.replace(/## Settled facts\n\n[^#]*/, ''))).toMatchObject({ span: '## Settled facts' })
})
