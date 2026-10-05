import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import { fill } from '../../cli/digests.ts'
import { looked } from '../../cli/look.ts'
import { file, LANE } from '../../cli/plan.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import { load, Seat } from '../../runner/rules.ts'
import { gates } from '../../store/approvals.ts'
import { decision } from '../../store/ask.ts'
import { decided, decisions, touches, type Verb } from '../../store/decisions.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addSetting } from '../../store/drift.ts'
import { logged, ofKind, pointers, runAt, runRows } from '../../store/events.ts'
import { retried, returnToLane } from '../../store/holds.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { busy } from '../../store/now.ts'
import { addPart } from '../../store/parts.ts'
import { allPlans, held, needsCeo, planById, planRows, putPlan, requeue, retry } from '../../store/plans.ts'
import { clear } from '../../store/refusals.ts'
import { split } from '../brief.ts'
import { byHand, cooLite, read, woke } from '../director.ts'
import { stop } from '../fixed.ts'
import { hold, unhold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { rule } from '../rule.ts'
import { parted } from '../split.ts'
import { afresh, drop, maybe, planDir, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-27T09:00:00.000Z')

const SPLIT = `---
outcome: split
parts:
  - title: the seat
    what: add the seat
    why: one job
    ends: the seat loads
  - title: the moves
    what: add the moves
    why: one job
    ends: the moves apply
---
`

const BLOCK = `Decide: may the pull request go upstream?
Options: (a) send it: the maintainer sees it; (b) hold it: the plan waits
Recommend: (a), the diff is signed off
If no answer by 2026-09-28 09:00: the plan stays held`

const askCeo = (block: string) => `${block}\n\n---\nmove: ask_ceo\nwhy: a maintainer outside our org sees this\nclass: 2\n---\n`

const FAULTS = [
  ['no Decide line', BLOCK.replace(/^Decide:.*\n/, '')],
  ['the Decide line does not end in "?"', BLOCK.replace('upstream?', 'upstream')],
  ['Options names fewer than two choices', BLOCK.replace('; (b) hold it: the plan waits', '')],
  ['the Recommend line names no option', BLOCK.replace('(a), ', '')],
  ['Options names more than three choices', BLOCK.replace('the plan waits\n', 'the plan waits; (c) x: y; (d) z: w\n')],
  ['no If no answer by line', BLOCK.replace(/\nIf no answer.*$/, '')],
] as const

const REPLY: Record<string, string> = {
  rule: '---\nmove: rule\nwhy: the ticket settles it\nanswer: build on main, not on plan 8\n---\n',
  waive: '---\nmove: waive\nwhy: the builder can fix the name\n---\n',
  split: SPLIT,
  close: '---\nmove: close\nwhy: the work is on main\n---\n',
  file: '---\nmove: file\nwhy: the tick counts a turn twice\nticket: the tick counts a turn twice\n---\n',
  ask_ceo: askCeo(BLOCK),
}

const PARTS = split(SPLIT) ?? []

const TWIN: Record<string, (db: Db, home: string) => void> = {
  rule: (db, home) => {
    rule(db, home, row(db), 'coo_lite', 'build on main, not on plan 8')
    afresh(home, 7, db.transaction(() => { clear(db, 7); return retry(db, row(db)) })())
  },
  waive: (db, home) => { afresh(home, 7, retried(db, 7, 'ceo')) },
  split: (db, home) => {
    parted(db, home, row(db), PARTS, wire())
    db.exec("UPDATE plans SET state = 'done' WHERE id = 7")
  },
  close: (db) => db.exec("UPDATE plans SET state = 'done', wait_reason = NULL WHERE id = 7"),
  file: (db, home) => {
    const url = 'https://github.com/caliperforge/caliperforge/issues/900'
    hold(db, home, 7, `${url}\n\nfiled`, now, file(db, 'coo', 'internal', 'machine', LANE.machine.seat, url, 0))
  },
  ask_ceo: (db) => { held(db, 7, 'ceo', 'a maintainer outside our org sees this') },
}

function seeded(apply: string | null) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  if (apply !== null) {
    addSetting(db, { key: 'director.apply', value: apply, who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
  }
  const approval = gates(db, 7, 'd'.repeat(64))
  pushedRow(db, { plan: 7, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, approval)
  const home = mkdtempSync(join(tmpdir(), 'cf-coolite-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  cpSync(join(repo, 'rules.seed.sql'), join(home, 'rules.seed.sql'))
  fill(home, '2026-09-27')
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'issue.md', ISSUE)
  put(home, 7, 'refusal.md', 'step 3 rails refused\n')
  return { db, home }
}

const ISSUE = '# Issue\n\nthe brief\n\n## Standing\n\n- no forced push\n'

function stub(text: string): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
      seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 }),
  }
}

function wire(): Wire {
  const no = (): never => { throw new Error('not in this test') }
  let n = 900
  return { send: no, open: no, close: no, runs: no, review: no, merged: no, comment: () => undefined,
    file: () => `https://github.com/caliperforge/caliperforge/issues/${String(n++)}` }
}

const row = (db: Db) => planById(db, 7)
const plan7 = (db: Db) => planRows(db).find((p) => p.id === 7)
const plans = (db: Db) => planRows(db)
const told = (db: Db) => ofKind(db, 'director').map(({ actor, outcome, message }) => ({ actor, outcome, message }))

const run = (db: Db, home: string, reply: string, posted: string[] = []) =>
  cooLite(db, home, row(db), stub(reply), now, (t) => void posted.push(t), wire())

test.each(Object.keys(REPLY))('live %s leaves plan 7 as its cf call does on a twin store', async (move) => {
  const live = seeded('1')
  const twin = seeded('1')
  await run(live.db, live.home, REPLY[move] ?? '')
  TWIN[move]?.(twin.db, twin.home)
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(told(live.db)).toEqual([{ actor: 'director', outcome: move ==='ask_ceo' ? 'needs_ceo' : 'pass', message: expect.stringMatching(new RegExp(`^${move}: `)) as string }])
})

test('live ask_ceo hands plan 7 to the ceo with no parked.md', async () => {
  const { db, home } = seeded('1')
  await run(db, home, REPLY.ask_ceo ?? '')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'ceo', held_why: 'a maintainer outside our org sees this',
    held_until: null, waits_on: null })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
})

test.each([['file', 'https://github.com/caliperforge/caliperforge/issues/900'], ['rule', null]])('D2 live %s logs pointer %s', async (move, pointer) => {
  const { db, home } = seeded('1')
  await run(db, home, REPLY[move] ?? '')
  expect(pointers(db, 'director')).toEqual([pointer])
})

const answer = () => `## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\nbuild on main, not on plan 8\n`

test('D1: a built plan\'s rule goes in issue.md and back to step 2', async () => {
  const { db, home } = seeded('1')
  await run(db, home, REPLY.rule ?? '')
  expect(maybe(home, 7, 'issue.md')).toBe(`# Issue\n\nthe brief\n\n${answer()}\n## Standing\n\n- no forced push\n`)
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
  expect(row(db).step).toBe(2)
})

test('D2: an unbuilt plan\'s rule goes in ask.md, back to its lane', async () => {
  const live = seeded('1')
  const twin = seeded('1')
  for (const { db } of [live, twin]) db.exec('DELETE FROM runs; UPDATE plans SET step = 1 WHERE id = 7')
  await run(live.db, live.home, REPLY.rule ?? '')
  unhold(twin.db, twin.home, 7, 'director')
  expect(maybe(live.home, 7, 'ask.md')).toBe(`the ask\n\n${answer()}`)
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(row(live.db).step).toBe(1)
})

test('D3: the packet carries sibling plans\' rulings, not others', async () => {
  const { db, home } = seeded('1')
  const at = (n: number) => `https://github.com/caliperforge/caliperforge/issues/${String(n)}`
  for (const [id, n] of [[8, 140], [9, 141]] as const) {
    putPlan(db, { id, pipe_id: 9, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-24', step: 2, retries: 0,
      lane: 'machine', seat: 'typescript_specialist', origin: at(n) })
  }
  db.exec(`INSERT INTO tickets (repo, number, title, lane, parent) VALUES
    ('caliperforge/caliperforge', 139, '138a one', 'machine', 138),
    ('caliperforge/caliperforge', 140, '138b two', 'machine', 138),
    ('caliperforge/caliperforge', 141, '200a three', 'machine', 200)`)
  put(home, 8, 'ask.md', 'the ask\n\n## Ruling\n\nuse main\n\n## Notes\n\nnot this\n')
  put(home, 9, 'ask.md', 'the ask\n\n## Ruling\n\nuse plan 8\n')
  const prompts: string[] = []
  const reply = stub(REPLY.ask_ceo ?? '')
  const seen: Provider = { ...reply, fire: (p) => { prompts.push(p.prompt); return reply.fire(p) } }
  await cooLite(db, home, row(db), seen, now, () => undefined, wire())
  expect(prompts[0]).toContain('# Rulings on sibling plans\n\nplan 8, ask.md:\n## Ruling\n\nuse main')
  expect(prompts[0]).not.toContain('not this')
  expect(prompts[0]).not.toContain('use plan 8')
})

const prompted = async (db: Db, home: string) => {
  const prompts: string[] = []
  const reply = stub(REPLY.ask_ceo ?? '')
  await cooLite(db, home, row(db), { ...reply, fire: (p) => { prompts.push(p.prompt); return reply.fire(p) } }, now, () => undefined, wire())
  return prompts[0]
}

test('D1: the packet carries the plan\'s own rulings first', async () => {
  const { db, home } = seeded('1')
  put(home, 7, 'rulings.md', 'round 3: write the workflow\n')
  put(home, 7, 'issue.md', '# Issue\n\nthe brief\n\n## Ruling\n\nkeep main\n\n## Standing\n\n- no forced push\n')
  expect(await prompted(db, home)).toContain('# Rulings on this plan\n\nrulings.md:\nround 3: write the workflow\n\nissue.md:\n## Ruling\n\nkeep main\n\n# Rulings on sibling plans')
})

test('D2: a plan with no rulings carries none', async () => {
  const { db, home } = seeded('1')
  expect(await prompted(db, home)).toContain('# Rulings on this plan\n\nnone\n\n# Rulings on sibling plans')
})

test('an upstream-key stop gets the pinned read tool and its keys', async () => {
  const { db, home } = seeded('1')
  put(home, 7, 'refusal.md', 'which keys does upstream config.toml take?\n')
  const keys = `github.com/o/r@${'a'.repeat(40)} config.toml: name, port`
  const reply = stub(`---\nmove: rule\nwhy: the pinned read settles it\nanswer: ${keys}\n---\n`)
  const packets: Parameters<Provider['fire']>[0][] = []
  const seen: Provider = { ...reply, fire: (p) => { packets.push(p); return reply.fire(p) } }
  await cooLite(db, home, row(db), seen, now, () => undefined, wire())
  expect(packets[0]?.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash(cf look:*)', 'mcp__github__read'])
  expect(basename(packets[0]?.transcript ?? '')).toBe('director.pending.transcript.jsonl')
  expect(Object.keys(packets[0]?.servers ?? {})).toEqual(['github'])
  expect(packets[0]?.prompt).toContain('mcp__github__read')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: 'rule: the pinned read settles it' }])
  const day = new Date().toISOString().slice(0, 10)
  expect(maybe(home, 7, 'issue.md')).toBe(`# Issue\n\nthe brief\n\n## Answer from the director (${day})\n\n${keys}\n\n## Standing\n\n- no forced push\n`)
  expect(row(db).step).toBe(2)
})

const LOOK = 'store SELECT input_tokens FROM runs WHERE plan = 7 AND step = 2'
const TOKENS = '---\nmove: rule\nwhy: cf look store read the run\nanswer: plan 7 step 2 took 1000 input tokens\n---\n'

function looker(db: Db, home: string): Provider {
  return { ...stub(''), fire: (p) => {
    if (!p.prompt.includes('cf look store')) return stub(REPLY.ask_ceo ?? '').fire(p)
    looked(db, home, planDir(home, 7), LOOK)
    return stub(TOKENS).fire(p)
  } }
}

function tokenStop() {
  const seed = seeded('1')
  put(seed.home, 7, 'refusal.md', 'how many input tokens did plan 7\'s step 2 run take?\n')
  return seed
}

test('D3: a run\'s token count is ruled after a cf look store', async () => {
  const { db, home } = tokenStop()
  await cooLite(db, home, row(db), looker(db, home), now, () => undefined, wire())
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'rule: cf look store read the run' }])
  expect(ofKind(db, 'look')).toEqual([{ plan: 7, kind: 'look', actor: 'coo_lite', outcome: 'pass', message: LOOK }])
  expect(maybe(home, 7, 'issue.md')).toContain('plan 7 step 2 took 1000 input tokens')
  expect(plan7(db)?.held_by).not.toBe('ceo')
})

test('D4: a prompt without cf look store hands the stop up', async () => {
  const { db, home } = tokenStop()
  const prompt = join(home, 'seats/director/prompt.md')
  writeFileSync(prompt, readFileSync(prompt, 'utf8').replace(/`cf look store[^`]*`/, 'it'))
  fill(home, '2026-09-27')
  await cooLite(db, home, row(db), looker(db, home), now, () => undefined, wire())
  expect(ofKind(db, 'look')).toEqual([])
  expect(plan7(db)).toMatchObject({ held_by: 'ceo' })
})

test.each(['/etc/x', '../x'])('D5: a rule naming %s writes nothing and is held by the coo', async (path) => {
  const { db, home } = seeded('1')
  await run(db, home, `---\nmove: rule\nwhy: the path settles it\nanswer: read ${path}\n---\n`)
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
})

test('failedMoveToCoo', async () => {
  const { db, home } = seeded('1')
  await run(db, home, '---\nmove: rule\nwhy: the path settles it\nanswer: read /etc/x\n---\n')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_ceo',
    message: 'rule did not apply, the answer names a path a ruling may not carry: the path settles it' }])
})

test.each([[null], ['0']])('shadow (director.apply %s): only proposes, in the inbox', async (apply) => {
  for (const [move, reply] of Object.entries(REPLY)) {
    const { db, home } = seeded(apply)
    addSetting(db, { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
    const was = plans(db)
    const posted: string[] = []
    await run(db, home, reply, posted)
    expect(plans(db)).toEqual(was)
    expect(posted).toEqual([])
    expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'director', note: expect.stringMatching(new RegExp(`^proposes ${move}: `)) as string })
    expect(told(db).map((t) => t.outcome)).toEqual(['needs_ceo'])
  }
})

test.each([
  { name: 'a plan that is not stopped', state: 'queued', reply: REPLY.rule ?? '' },
  { name: 'a reply with no fence', state: 'blocked_on_ceo', reply: 'I would rule on it.' },
  { name: 'rule without answer', state: 'blocked_on_ceo', reply: '---\nmove: rule\nwhy: settled\n---\n' },
  { name: 'file without ticket', state: 'blocked_on_ceo', reply: '---\nmove: file\nwhy: a bug\n---\n' },
])('$name changes no plan row and tells a person', async ({ state, reply }) => {
  const { db, home } = seeded('1')
  if (state === 'queued') requeue(db, 7, row(db).step)
  const was = plans(db)
  const posted: string[] = []
  await run(db, home, reply, posted)
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.outcome)).toEqual(['needs_ceo'])
  expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'director' })
  expect(posted).toHaveLength(1)
})

test('close with no pushed deliverable is held by the coo', async () => {
  const { db, home } = seeded('1')
  db.exec('DELETE FROM deliverables')
  await run(db, home, REPLY.close ?? '')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^close did not apply, /)])
})

const targeted = (db: Db) => db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706');
    UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7`)

test('a split parted cannot file is held by the coo', async () => {
  const { db, home } = seeded('1')
  targeted(db)
  await run(db, home, SPLIT)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^split did not apply, /)])
  expect(plans(db)).toHaveLength(1)
})

const clock = new Date()
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)

function stopped(db: Db, id: number, minutes: number, verb: Verb = 'ask_coo') {
  if (!allPlans(db).some((p) => p.id === id)) {
    putPlan(db, { id, pipe_id: 9, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-24', step: 4, retries: 0,
      lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/caliperforge/caliperforge/issues/${String(id + 900)}` })
    needsCeo(db, planById(db, id))
  }
  decided(db, { plan: id, step: 4, wait_reason: 'blocked_on_ceo', verb, why: 'a stop', evidence: null, tokens: 0 }, ago(minutes))
}

const fires = (db: Db) => runRows(db).filter((r) => r.seat === 'director').map(({ plan }) => ({ plan }))
const pile = (db: Db, home: string, posted: string[] = []) =>
  byHand(db, home, stub(REPLY.ask_ceo ?? ''), clock, (t) => void posted.push(t), wire())

test.each([
  { name: 'oldestFirst', ages: [30, 20, 10], want: [{ plan: 7 }] },
  { name: 'youngFires', ages: [1], want: [{ plan: 7 }] },
])('$name', async ({ ages, want }) => {
  const { db, home } = seeded('1')
  ages.forEach((m, i) => { stopped(db, 7 + i, m) })
  await pile(db, home)
  expect(fires(db)).toEqual(want)
})

test('a live director run holds the trigger', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  busy(db, 9, 'director', 'ruling', clock)
  await pile(db, home)
  expect(fires(db)).toEqual([])
})

const passed = (db: Db, minutes: number) =>
  logged(db, { plan: 7, kind: 'coo_lite', actor: 'coo_lite', outcome: 'pass', message: 'rule: x', pointer: null, run: null }, ago(minutes))

test('D4: a new stop on a plan answered once today is fired on', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 50)
  passed(db, 60)
  await pile(db, home)
  expect(fires(db)).toEqual([{ plan: 7 }])
})

test('D4: a third stop in a day goes to a person, once', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 50)
  passed(db, 60)
  passed(db, 55)
  const posted: string[] = []
  await pile(db, home, posted)
  await pile(db, home, posted)
  expect(fires(db)).toEqual([])
  expect(told(db).filter((t) => t.outcome === 'needs_ceo')).toEqual([{ actor: 'director', outcome:'needs_ceo', message: 'ask_coo: director answered this plan twice today' }])
  expect(all(home).filter((e) => e.kind === 'blocked')).toHaveLength(1)
  expect(posted).toHaveLength(1)
})

test('answeredSkipped', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  logged(db, { plan: 7, kind: 'coo_lite', actor: 'coo_lite', outcome: 'needs_ceo', message: 'x', pointer: null, run: null }, ago(5))
  await pile(db, home)
  expect(fires(db)).toEqual([{ plan: 8 }])
})

test('coo_lite.max_daily caps the runs a day', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  load(db, home)
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'director', ago(60 + i))
  await pile(db, home)
  expect(fires(db)).toHaveLength(12)
  addSetting(db, { key: 'coo_lite.max_daily', value: '13', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
  await pile(db, home)
  expect(fires(db)).toHaveLength(13)
})

const byHanded = (db: Db, home: string) => byHand(db, home, stub(REPLY.ask_ceo ?? ''), clock, () => undefined, wire())

test('by hand, one young stop fires one run on it', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 10)
  await byHanded(db, home)
  expect(fires(db)).toEqual([{ plan: 7 }])
  expect(told(db)).toHaveLength(1)
})

test('by hand, the day cap fires nothing', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 10)
  load(db, home)
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'director', ago(60 + i))
  expect(await byHanded(db, home)).toBe('cap reached: 12 director runs today')
  expect(fires(db)).toHaveLength(12)
  expect(told(db)).toEqual([])
})

test('by hand, a live director run fires nothing', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 10)
  stopped(db, 9, 5)
  busy(db, 9, 'director', 'ruling', clock)
  expect(await byHanded(db, home)).toBe('a director run is live')
  expect(fires(db)).toEqual([])
})

test('ceo-held, parked and retried plans are not stops', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [60, 60, 60].entries()) stopped(db, 7 + i, m)
  held(db, 7, 'ceo', 'his call')
  hold(db, home, 8, 'parked', clock, null, new Date('2099-01-01T00:00:00Z'))
  stopped(db, 9, 55, 'retry')
  await pile(db, home)
  expect(fires(db)).toEqual([])
  expect(told(db)).toEqual([])
})

test('a long why and a long ticket title still read', () => {
  const why = 'the checkout holds only README.md and LICENSE, so the upstream layout cannot be settled here. '.repeat(8).trim()
  const got = read(`reasoning\n\n\`\`\`\n---\nmove: file\nwhy: ${why}\nticket: ${'t'.repeat(200)}\n---\n\`\`\``)
  expect(got).toMatchObject({ move: 'file', why })
  expect(got !== null && 'ticket' in got ? got.ticket?.length : 0).toBe(140)
})

test('a seat with no write_paths may hold only Bash(cf look:*)', () => {
  const card = (tools: string[]) => ({ seat: 'director', model: 'm', effort: 'low', tools, write_paths: [] })
  expect(Seat.parse(card(['Read', 'Bash(cf look:*)'])).tools).toEqual(['Read', 'Bash(cf look:*)'])
  for (const tools of [['Read', 'Bash(git:*)'], ['Read', 'Bash(cf look:*)', 'Bash'], ['Read', 'Bash(cf look:x)'], ['Read', 'Bash(cf:*)']]) {
    expect(() => Seat.parse(card(tools))).toThrow(/save Bash\(cf look:\*\)/)
  }
})

test('quotedWhy', () => {
  expect(read('---\nmove: rule\nwhy: "Desk alarm" means the sign-off card\nanswer: use the card\n---\n'))
    .toMatchObject({ move: 'rule', why: '"Desk alarm" means the sign-off card', answer: 'use the card' })
})

test('parentAsk', async () => {
  const { db, home } = seeded('1')
  const parent = file(db, 'coo', LANE.machine.pipe, 'machine', LANE.machine.seat, 'https://github.com/caliperforge/caliperforge/issues/900', 0)
  put(home, parent, 'ask.md', '# parent\n\nseed: coo_lite, fixer\n')
  addPart(db, { parent, n: 0, url: 'https://github.com/caliperforge/caliperforge/issues/901', title: '9a: part', body: 'part body', plan: 7, after: null })
  expect(await prompted(db, home)).toContain('# Parent ticket\n\n# parent\n\nseed: coo_lite, fixer\n')
})

test('record', async () => {
  const { db, home } = seeded('1')
  expect(await prompted(db, home)).toMatch(/# Record\n\n\d+ runs, \d+ tokens, \$\d+\.\d\d\n/)
})

const WHY = 'rename schema/0036_x.sql to 0040_x.sql in src and issue.md. '.repeat(5).trim()
const FIX = `---\nmove: fix\nwhy: ${WHY}\n---\n`

function bySeat(packets: Packet[], reply = FIX): Provider {
  const coo = stub(reply)
  const fix = stub('---\ndid: renamed the migration\nthen: return\nwhy: the rails find the file now\n---\n')
  return { ...coo, fire: (p) => { packets.push(p); return (basename(p.transcript).startsWith('fixer') ? fix : coo).fire(p) } }
}

const fixLive = (db: Db) => db.exec(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
  VALUES ('fixer.mode', 'live', 'ceo', 'ruling', 't', '2026-09-27')`)

test('fixHandsOff', async () => {
  const { db, home } = seeded('1')
  fixLive(db)
  mkdirSync(join(srcDir(home, 7), '.git'), { recursive: true })
  const packets: Packet[] = []
  await cooLite(db, home, row(db), bySeat(packets), now, () => undefined, wire())
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.prompt).toContain(`# Orchestrator\n\nask_coo: ${WHY}`)
  expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
  expect(touches(db, 7, now)).toBe(1)
  expect(row(db).state).toBe('queued')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: `fix: ${WHY}` }])
})

test('fixFailsOnce', async () => {
  const { db, home } = seeded('1')
  const packets: Packet[] = []
  const posted: string[] = []
  await cooLite(db, home, row(db), bySeat(packets), now, (t) => void posted.push(t), wire())
  expect(packets.map((p) => p.prompt.includes('# Fixer'))).toEqual([false, true])
  expect(plan7(db)).toMatchObject({ held_by: 'coo' })
  expect(posted).toHaveLength(1)
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_ceo', message: expect.stringMatching(/^fix did not apply, /) as string }])
})

test('returnMove', async () => {
  const live = seeded('1')
  const twin = seeded('1')
  await run(live.db, live.home, '---\nmove: return\nwhy: a one-off network blip\n---\n')
  afresh(twin.home, 7, returnToLane(twin.db, 7, 'director'))
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(row(live.db)).toMatchObject({ state: 'queued', step: 4 })
  for (const reply of ['---\nmove: return\nwhy: a blip\n---\n', FIX]) {
    const { db, home } = seeded(null)
    fixLive(db)
    const was = plans(db)
    const packets: Packet[] = []
    const posted: string[] = []
    await cooLite(db, home, row(db), bySeat(packets, reply), now, (t) => void posted.push(t), wire())
    expect(plans(db)).toEqual(was)
    expect(packets).toHaveLength(1)
    expect(posted).toEqual([])
  }
})

test('askCeoNeedsClass', async () => {
  expect(read('---\nmove: ask_ceo\nwhy: which file\n---\n')).toBeNull()
  expect(read('---\nmove: ask_ceo\nwhy: which file\nclass: 5\n---\n')).toBeNull()
  const classed = seeded('1')
  await run(classed.db, classed.home, REPLY.ask_ceo ?? '')
  expect(plan7(classed.db)).toMatchObject({ held_by: 'ceo' })
  expect(told(classed.db).map((t) => t.message)).toEqual([`ask_ceo: a maintainer outside our org sees this\n\n${BLOCK}`])
  const { db, home } = seeded('1')
  held(db, 7, 'coo', 'a stop')
  await run(db, home, '---\nmove: ask_ceo\nwhy: which file\n---\n')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_ceo', message: 'ask_ceo: no readable answer' }])
  expect(plan7(db)).toMatchObject({ held_by: 'coo' })
})

const ASK_COO = '---\nmove: ask_coo\nwhy: the coo should pick\n---\n'

function inTurn(replies: string[], prompts: string[]): Provider {
  return { ...stub(''), fire: (p) => { prompts.push(p.prompt); return stub(replies[prompts.length - 1] ?? '').fire(p) } }
}

function commenting(comments: [string, number, string][]): Wire {
  return { ...wire(), comment: (repo, no, body) => { comments.push([repo, no, body]) } }
}

const failedFixes = (db: Db, evidence: string) => {
  for (let i = 0; i < 2; i++) decided(db, { plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: 'a fix', evidence, tokens: 0 })
}

test('D1: ask_coo on one failed fix is fenced, the next move runs', async () => {
  const { db, home } = seeded('1')
  decided(db, { plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: 'a fix', evidence: stop(home, 7), tokens: 0 })
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([ASK_COO, REPLY.rule ?? ''], prompts), now, () => undefined, wire())
  expect(prompts.map((p) => p.includes('# Fence\n\nask_coo is refused: 1 failed fixes'))).toEqual([false, true])
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: 'rule: the ticket settles it' }])
})

test('D2: ask_coo after two failed fixes holds plan 7 for the coo', async () => {
  const { db, home } = seeded('1')
  failedFixes(db, stop(home, 7))
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([ASK_COO], prompts), now, () => undefined, wire())
  expect(prompts).toHaveLength(1)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo', held_why: 'the coo should pick' })
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_ceo', message: 'ask_coo: the coo should pick' }])
})

test('D3: failed fixes on an earlier stop do not count', async () => {
  const { db, home } = seeded('1')
  failedFixes(db, stop(home, 7))
  put(home, 7, 'refusal.md', 'step 3 rails refused again\n')
  const was = plans(db)
  await cooLite(db, home, row(db), inTurn([ASK_COO, ASK_COO], []), now, () => undefined, wire())
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^ask_coo: refused by the fence/)])
})

test.each(FAULTS.slice(0, 4))('D2: an ask_ceo with %s is asked again', async (reason, block) => {
  const { db, home } = seeded('1')
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([askCeo(block), REPLY.rule ?? ''], prompts), now, () => undefined, wire())
  expect(prompts.map((p) => p.includes(`# Fence\n\nask_ceo is refused: ${reason}`))).toEqual([false, true])
  expect(plan7(db)).not.toMatchObject({ held_by: 'ceo' })
})

test('D3: an ask_ceo refused twice leaves the plans as they were', async () => {
  const { db, home } = seeded('1')
  const was = plans(db)
  const bad = askCeo(FAULTS[0][1])
  await cooLite(db, home, row(db), inTurn([bad, bad], []), now, () => undefined, wire())
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.message)).toEqual(['ask_ceo: refused by the fence, no Decide line'])
})

test.each([
  ['ask_coo: refused by the fence, 0 failed fixes on this stop', [askCeo(FAULTS[0][1]), ASK_COO]],
  ['ask_ceo: refused by the fence, no Decide line', [ASK_COO, askCeo(FAULTS[0][1])]],
])('D3: a second refused move logs %s', async (message, replies) => {
  const { db, home } = seeded('1')
  const was = plans(db)
  await cooLite(db, home, row(db), inTurn(replies, []), now, () => undefined, wire())
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.message)).toEqual([message])
})

test.each(FAULTS)('D1: decision refuses %s', (refused, block) => {
  expect(decision(askCeo(block))).toEqual({ refused })
})

test('D1: decision returns a valid block as written', () => {
  expect(decision(`thinking\n\n${askCeo(BLOCK)}`)).toEqual({ block: BLOCK })
})

test('D4: the fix decision carries the stop hash', async () => {
  const { db, home } = seeded('1')
  fixLive(db)
  mkdirSync(join(srcDir(home, 7), '.git'), { recursive: true })
  const at = stop(home, 7)
  await cooLite(db, home, row(db), bySeat([]), now, () => undefined, wire())
  expect(decisions(db, 7).map((d) => d.evidence)).toEqual([at])
})

test('D5: a rule writes the reading, comments once on the origin', async () => {
  const { db, home } = seeded('1')
  const comments: [string, number, string][] = []
  await cooLite(db, home, row(db), stub(REPLY.rule ?? ''), now, () => undefined, commenting(comments))
  expect(maybe(home, 7, 'issue.md')).toContain('build on main, not on plan 8')
  expect(comments).toEqual([['caliperforge/caliperforge', 139, 'Ruled by director on plan 7.\n\nbuild on main, not on plan 8']])
})

test.each([
  { name: 'a refused rule', reply: '---\nmove: rule\nwhy: the path settles it\nanswer: read /etc/x\n---\n', origin: true },
  { name: 'a plan with no origin', reply: REPLY.rule ?? '', origin: false },
])('D6: $name makes no comment', async ({ reply, origin }) => {
  const { db, home } = seeded('1')
  if (!origin) targeted(db)
  const comments: [string, number, string][] = []
  await cooLite(db, home, row(db), stub(reply), now, () => undefined, commenting(comments))
  expect(told(db).map((t) => t.outcome)).toEqual([origin ? 'needs_ceo' : 'pass'])
  expect(comments).toEqual([])
})

const wokeAt = new Date('2026-09-24T12:00:00.000Z')
const ASK_CEO = `thinking\n\n${askCeo(BLOCK)}`
const SAID = 'ask_ceo: a maintainer outside our org sees this'

function wokeSeeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  const home = mkdtempSync(join(tmpdir(), 'cf-orch-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'base.sha', `${'a'.repeat(40)}\n`)
  writeFileSync(join(srcDir(home, 7), 'index.ts'), 'export {}\n')
  return { db, home }
}

function wokeStub(text: string, fires: string[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      fires.push(packet.prompt)
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 20, output: 30 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

function state(db: Db, home: string) {
  const src = srcDir(home, 7)
  return {
    plan: db.prepare('SELECT * FROM plans WHERE id = 7').get(),
    files: readdirSync(src, { recursive: true, encoding: 'utf8' }).map((f) => [f, readFileSync(join(src, f), 'utf8')]),
  }
}

const wokeRuns = (db: Db) => db.prepare(`SELECT step, input_tokens, cache_read_tokens, output_tokens FROM runs
  WHERE plan = 7 AND seat = 'director'`).all()
const wokeTold = (db: Db) => db.prepare("SELECT outcome, message FROM events WHERE plan = 7 AND kind = 'director'").all()
const leases = (db: Db) => db.prepare('SELECT count(*) AS n FROM leases').get()

const blocked = (db: Db, home: string) => {
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\nthe binding is stale\n')
}

test('firesOnStop', async () => {
  const { db, home } = wokeSeeded()
  blocked(db, home)
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, (t) => void posted.push(t))
  await wake()
  expect(wokeRuns(db)).toEqual([{ step: 4, input_tokens: 10, cache_read_tokens: 20, output_tokens: 30 }])
  expect(wokeTold(db)).toEqual([{ outcome: 'needs_ceo', message: SAID }])
  expect(fires[0]).toContain('# Stop\n\nstep 4 review refused by code_quality\n\nthe binding is stale')
  expect(fires[0]).toContain('# Orchestrator\n\nnone')
  const first = maybe(home, 7, 'orchestrator.md') ?? ''
  expect(first.split('\n')[0]).toMatch(/^step 4 blocked [0-9a-f]{12}$/)
  expect(first.split('\n').slice(1)).toEqual(['', SAID, ''])
  expect(all(home).map((e) => e.note)).toEqual([`proposes ${SAID}`])
  expect(state(db, home)).toEqual(before)
  expect(posted).toEqual([])
  expect(leases(db)).toEqual({ n: 0 })
  await wake()
  expect(fires).toHaveLength(1)
  expect(wokeTold(db)).toHaveLength(1)
  expect(maybe(home, 7, 'orchestrator.md')).toBe(first)
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\na different finding\n')
  await wake()
  expect(wokeRuns(db)).toHaveLength(2)
  expect(wokeTold(db)).toHaveLength(2)
  expect(fires[1]).toContain('a different finding')
  expect(fires[1]).toContain(`# Orchestrator\n\n${first}`)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).not.toBe(first.split('\n')[0])
  drop(home, 7, 'refusal.md')
  put(home, 7, 'question.md', 'which helper do I call?\n')
  await wake()
  expect(fires[2]).toContain('# Stop\n\nwhich helper do I call?')
  expect(wokeRuns(db)).toHaveLength(3)
  expect(state(db, home)).toEqual(before)
  expect(posted).toEqual([])
})

test.each([
  { name: 'held by the ceo', leased: 0, set: (db: Db, home: string) => {
    blocked(db, home)
    db.exec("UPDATE plans SET held_by = 'ceo' WHERE id = 7")
  } },
  { name: 'parked', leased: 0, set: (db: Db, home: string) => { blocked(db, home); put(home, 7, 'parked.md', '# Held\n') } },
  { name: 'leased by another live tick', leased: 1, set: (db: Db, home: string) => {
    blocked(db, home)
    db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (7, ?, ?)').run(process.ppid, wokeAt.toISOString())
  } },
  { name: 'a reason outside WAKE', leased: 0, set: (db: Db) => db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7") },
])('D3 a plan $name is not woken', async ({ leased, set }) => {
  const { db, home } = wokeSeeded()
  set(db, home)
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  await woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, (t) => void posted.push(t))
  expect(fires).toEqual([])
  expect(wokeRuns(db)).toEqual([])
  expect(wokeTold(db)).toEqual([])
  expect(maybe(home, 7, 'orchestrator.md')).toBe(null)
  expect(all(home)).toEqual([])
  expect(posted).toEqual([])
  expect(state(db, home)).toEqual(before)
  expect(leases(db)).toEqual({ n: leased })
})

test.each([
  { why: 'the binding is stale\nmore', by: 'coo', said: 'the binding is stale', blocks: [], fired: 1 },
  { why: `thinking\n${BLOCK}`, by: 'ceo', said: 'Decide: may the pull request go upstream?', blocks: [BLOCK], fired: 0 },
])('D4 D5 needsCeo holds on the $by', async ({ why, by, said, blocks, fired }) => {
  const { db, home } = wokeSeeded()
  blocked(db, home)
  db.exec("UPDATE plans SET held_by = 'ceo' WHERE id = 7")
  needsCeo(db, planById(db, 7), why)
  expect(planRows(db).find((r) => r.id === 7)).toMatchObject({ state: 'blocked_on_ceo', held_by: by, held_why: said })
  expect(ofKind(db, 'needs_ceo').map((e) => e.message)).toEqual(blocks)
  const fires: string[] = []
  await woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, () => undefined)
  expect(fires).toHaveLength(fired)
})

test('D4 a running plan at its ceiling: one post per head', async () => {
  const { db, home } = wokeSeeded()
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, (t) => void posted.push(t))
  for (let i = 0; i < 2; i += 1) await wake()
  expect(fires).toEqual([])
  expect(wokeRuns(db)).toEqual([])
  expect(wokeTold(db)).toEqual([{ outcome: 'needs_ceo', message: 'ask_ceo: plan is running, not stopped' }])
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(all(home).map((e) => [e.kind, e.note])).toEqual([['blocked', 'ask_ceo: plan is running, not stopped']])
  expect(maybe(home, 7, 'orchestrator.md')).toBe('step 4 token_ceiling\n\nask_ceo: plan is running, not stopped\n')
  expect(state(db, home)).toEqual(before)
  expect(leases(db)).toEqual({ n: 0 })
  db.exec("UPDATE plans SET wait_reason = 'ready_proof' WHERE id = 7")
  await wake()
  expect(posted).toHaveLength(2)
  expect(wokeTold(db)).toHaveLength(2)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toBe('step 4 ready_proof')
})

test('the store takes blocked_on_ceo, refuses an unknown reason',() => {
  const { db } = wokeSeeded()
  const insert = (reason: string) => db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why)
    VALUES (7, 4, ?, 'ask_coo', 'x')`).run(reason)
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
})
