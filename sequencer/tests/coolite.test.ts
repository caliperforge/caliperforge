import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import { fill } from '../../cli/digests.ts'
import { file, LANE } from '../../cli/plan.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import { load } from '../../runner/rules.ts'
import { decisions, touches } from '../../store/decisions.ts'
import { runAt } from '../../store/events.ts'
import { retried, returnToLane } from '../../store/holds.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { busy } from '../../store/now.ts'
import { addPart } from '../../store/parts.ts'
import { held, PlanRow, retry } from '../../store/plans.ts'
import { clear } from '../../store/refusals.ts'
import { split } from '../brief.ts'
import { byHand, cooLite, read } from '../coolite.ts'
import { hold, unhold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { rule } from '../rule.ts'
import { parted } from '../split.ts'
import { afresh, maybe, put, srcDir } from '../workspace.ts'

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

const REPLY: Record<string, string> = {
  rule: '---\nmove: rule\nwhy: the ticket settles it\nanswer: build on main, not on plan 8\n---\n',
  waive: '---\nmove: waive\nwhy: the builder can fix the name\n---\n',
  split: SPLIT,
  close: '---\nmove: close\nwhy: the work is on main\n---\n',
  file: '---\nmove: file\nwhy: the tick counts a turn twice\nticket: the tick counts a turn twice\n---\n',
  ask_ceo: '---\nmove: ask_ceo\nwhy: a maintainer outside our org sees this\nclass: 2\n---\n',
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
    db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
      VALUES ('coo_lite.apply', ?, 'ceo', 'ruling', 't', '2026-09-27')`).run(apply)
  }
  const approval = db.prepare(`INSERT INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('plan', 7, ?, 'gates', 'approved', '2026-09-27T00:00:00.000Z') RETURNING id`).get('d'.repeat(64)) as { id: number }
  db.prepare(`INSERT INTO deliverables (plan_id, step, seat, diff_digest, state, tests_pass, byte_identical_elsewhere,
    fork_ci_green, bot_clean, target_warm, approval_id, evidence)
    VALUES (7, 6, 'typescript_specialist', ?, 'pushed', 1, 1, 1, 1, 1, ?, 'https://github.com/caliperforge/caliperforge/pull/1')`)
    .run('d'.repeat(64), approval.id)
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

const row = (db: Db) => PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = 7').get())
const plan7 = (db: Db) => db.prepare('SELECT * FROM plans WHERE id = 7').get()
const plans = (db: Db) => db.prepare('SELECT * FROM plans ORDER BY id').all()
const told = (db: Db) => db.prepare("SELECT actor, outcome, message FROM events WHERE kind = 'coo_lite'").all() as
  { actor: string; outcome: string; message: string }[]

const run = (db: Db, home: string, reply: string, posted: string[] = []) =>
  cooLite(db, home, row(db), stub(reply), now, (t) => void posted.push(t), wire())

test.each(Object.keys(REPLY))('live %s leaves plan 7 as its cf call does on a twin store', async (move) => {
  const live = seeded('1')
  const twin = seeded('1')
  await run(live.db, live.home, REPLY[move] ?? '')
  TWIN[move]?.(twin.db, twin.home)
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(told(live.db)).toEqual([{ actor: 'coo_lite', outcome: move === 'ask_ceo' ? 'needs_ceo' : 'pass', message: expect.stringMatching(new RegExp(`^${move}: `)) as string }])
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
  expect(db.prepare("SELECT pointer FROM events WHERE kind = 'coo_lite'").all()).toEqual([{ pointer }])
})

const answer = () => `## Answer from the coo_lite (${new Date().toISOString().slice(0, 10)})\n\nbuild on main, not on plan 8\n`

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
  unhold(twin.db, twin.home, 7, 'coo_lite')
  expect(maybe(live.home, 7, 'ask.md')).toBe(`the ask\n\n${answer()}`)
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(row(live.db).step).toBe(1)
})

test('D3: the packet carries sibling plans\' rulings, not others', async () => {
  const { db, home } = seeded('1')
  const at = (n: number) => `https://github.com/caliperforge/caliperforge/issues/${String(n)}`
  const plan = db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, 9, 'pr_path', 'queued', '2026-09-24', 2, 0, 1, 'machine', 'typescript_specialist', ?)`)
  plan.run(8, at(140))
  plan.run(9, at(141))
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
  expect(packets[0]?.tools).toEqual(['Read', 'Glob', 'Grep', 'mcp__github__read'])
  expect(Object.keys(packets[0]?.servers ?? {})).toEqual(['github'])
  expect(packets[0]?.prompt).toContain('mcp__github__read')
  expect(told(db)).toEqual([{ actor: 'coo_lite', outcome: 'pass', message: 'rule: the pinned read settles it' }])
  const day = new Date().toISOString().slice(0, 10)
  expect(maybe(home, 7, 'issue.md')).toBe(`# Issue\n\nthe brief\n\n## Answer from the coo_lite (${day})\n\n${keys}\n\n## Standing\n\n- no forced push\n`)
  expect(row(db).step).toBe(2)
})

test.each(['/etc/x', '../x'])('D5: a rule naming %s writes nothing and is held by the coo', async (path) => {
  const { db, home } = seeded('1')
  await run(db, home, `---\nmove: rule\nwhy: the path settles it\nanswer: read ${path}\n---\n`)
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
  expect(db.prepare('SELECT state, held_by FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'coo' })
})

test('failedMoveToCoo', async () => {
  const { db, home } = seeded('1')
  await run(db, home, '---\nmove: rule\nwhy: the path settles it\nanswer: read /etc/x\n---\n')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db)).toEqual([{ actor: 'coo_lite', outcome: 'needs_ceo',
    message: 'rule did not apply, the answer names a path a ruling may not carry: the path settles it' }])
})

test.each([[null], ['0']])('shadow (coo_lite.apply %s): no plan row changes and the proposal is in the inbox', async (apply) => {
  for (const [move, reply] of Object.entries(REPLY)) {
    const { db, home } = seeded(apply)
    const was = plans(db)
    const posted: string[] = []
    await run(db, home, reply, posted)
    expect(plans(db)).toEqual(was)
    expect(posted).toEqual([])
    expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'coo_lite', note: expect.stringMatching(new RegExp(`^proposes ${move}: `)) as string })
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
  db.prepare('UPDATE plans SET state = ? WHERE id = 7').run(state)
  const was = plans(db)
  const posted: string[] = []
  await run(db, home, reply, posted)
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.outcome)).toEqual(['needs_ceo'])
  expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'coo_lite' })
  expect(posted).toHaveLength(1)
})

test('close with no pushed deliverable is held by the coo', async () => {
  const { db, home } = seeded('1')
  db.exec('DELETE FROM deliverables')
  await run(db, home, REPLY.close ?? '')
  expect(db.prepare('SELECT state, held_by FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^close did not apply, /)])
})

test('a split parted cannot file is held by the coo', async () => {
  const { db, home } = seeded('1')
  db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706');
    UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7`)
  await run(db, home, SPLIT)
  expect(db.prepare('SELECT state, held_by FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^split did not apply, /)])
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 1 })
})

const clock = new Date()
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)

function stopped(db: Db, id: number, minutes: number, verb = 'ask_coo') {
  if (db.prepare('SELECT 1 FROM plans WHERE id = ?').get(id) === undefined) {
    db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
      VALUES (?, 9, 'pr_path', 'running', '2026-09-24', 4, 0, 1, 'machine', 'typescript_specialist', ?)`)
      .run(id, `https://github.com/caliperforge/caliperforge/issues/${String(id + 900)}`)
    db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(id)
  }
  db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, at) VALUES (?, 4, 'blocked_on_ceo', ?, 'a stop', ?)`)
    .run(id, verb, ago(minutes))
}

const fires = (db: Db) => db.prepare("SELECT plan FROM runs WHERE seat = 'coo_lite'").all()
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

test('a live coo_lite run holds the trigger', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  busy(db, 9, 'coo_lite', 'ruling', clock)
  await pile(db, home)
  expect(fires(db)).toEqual([])
})

const passed = (db: Db, minutes: number) =>
  db.prepare(`INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (7, ?, 'coo_lite', 'coo_lite', 'pass', 'rule: x')`).run(ago(minutes))

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
  expect(told(db).filter((t) => t.outcome === 'needs_ceo')).toEqual([{ actor: 'coo_lite', outcome: 'needs_ceo', message: 'ask_coo: coo_lite answered this plan twice today' }])
  expect(all(home).filter((e) => e.kind === 'blocked')).toHaveLength(1)
  expect(posted).toHaveLength(1)
})

test('answeredSkipped', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  db.prepare(`INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (7, ?, 'coo_lite', 'coo_lite', 'needs_ceo', 'x')`).run(ago(5))
  await pile(db, home)
  expect(fires(db)).toEqual([{ plan: 8 }])
})

test('coo_lite.max_daily caps the runs a day', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  load(db, home)
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'coo_lite', ago(60 + i))
  await pile(db, home)
  expect(fires(db)).toHaveLength(12)
  db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
    VALUES ('coo_lite.max_daily', '13', 'ceo', 'ruling', 't', '2026-09-27')`).run()
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
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'coo_lite', ago(60 + i))
  expect(await byHanded(db, home)).toMatch(/^cap reached/)
  expect(fires(db)).toHaveLength(12)
  expect(told(db)).toEqual([])
})

test('by hand, a live coo_lite run fires nothing', async () => {
  const { db, home } = seeded('1')
  stopped(db, 7, 10)
  stopped(db, 9, 5)
  busy(db, 9, 'coo_lite', 'ruling', clock)
  expect(await byHanded(db, home)).toBe('a coo_lite run is live')
  expect(fires(db)).toEqual([])
})

test('ceo-held, parked and retried plans are not stops', async () => {
  const { db, home } = seeded('1')
  for (const [i, m] of [60, 60, 60].entries()) stopped(db, 7 + i, m)
  held(db, 7, 'ceo', 'his call')
  hold(db, home, 8, 'parked', clock)
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
  expect(told(db)).toEqual([{ actor: 'coo_lite', outcome: 'pass', message: `fix: ${WHY}` }])
})

test('fixFailsOnce', async () => {
  const { db, home } = seeded('1')
  const packets: Packet[] = []
  const posted: string[] = []
  await cooLite(db, home, row(db), bySeat(packets), now, (t) => void posted.push(t), wire())
  expect(packets.map((p) => p.prompt.includes('# Fixer'))).toEqual([false, true])
  expect(plan7(db)).toMatchObject({ held_by: 'coo' })
  expect(posted).toHaveLength(1)
  expect(told(db)).toEqual([{ actor: 'coo_lite', outcome: 'needs_ceo', message: expect.stringMatching(/^fix did not apply, /) as string }])
})

test('returnMove', async () => {
  const live = seeded('1')
  const twin = seeded('1')
  await run(live.db, live.home, '---\nmove: return\nwhy: a one-off network blip\n---\n')
  afresh(twin.home, 7, returnToLane(twin.db, 7, 'coo_lite'))
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
  expect(told(classed.db).map((t) => t.message)).toEqual(['ask_ceo: a maintainer outside our org sees this'])
  const { db, home } = seeded('1')
  held(db, 7, 'coo', 'a stop')
  await run(db, home, '---\nmove: ask_ceo\nwhy: which file\n---\n')
  expect(told(db)).toEqual([{ actor: 'coo_lite', outcome: 'needs_ceo', message: 'ask_ceo: no readable answer' }])
  expect(plan7(db)).toMatchObject({ held_by: 'coo' })
})
