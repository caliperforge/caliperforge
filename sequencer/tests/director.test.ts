import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { heldBy } from '../../cli/brief.ts'
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
import { addFinding, addSetting, findings, setting } from '../../store/drift.ts'
import { logged, ofKind, pointers, runAt, runRows } from '../../store/events.ts'
import { retried, returnToLane } from '../../store/holds.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { cap, width } from '../../store/lanes.ts'
import { busy } from '../../store/now.ts'
import { addPart } from '../../store/parts.ts'
import { allPlans, held, needsCeo, pipeOf, planById, planRows, putPlan, requeue, retry } from '../../store/plans.ts'
import { clear, fingerprint, overBudget } from '../../store/refusals.ts'
import { split } from '../brief.ts'
import { byHand, cooLite, read, woke } from '../director.ts'
import { mechanisms } from '../drift.ts'
import { answer as decide } from '../finding.ts'
import { stop } from '../fixed.ts'
import { hold, unhold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { rule } from '../rule.ts'
import { parted } from '../split.ts'
import { unruled } from '../unruled.ts'
import { afresh, drop, git, headSha, maybe, planDir, put, srcDir } from '../workspace.ts'

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

const P2 = '<img alt="P2" src="https://greptile.com/p2.svg">'

function greptileStop() {
  const { db, home } = seeded('1')
  db.exec('UPDATE plans SET step = 6 WHERE id = 7')
  const src = srcDir(home, 7)
  git(src, ['init', '-q'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'built'])
  const sha = headSha(src)
  put(home, 7, `findings-${sha}.md`, `- G11 ${P2} the empty name is never refused\n- G12 ${P2} the port is unchecked\n`)
  put(home, 7, 'refusal.md', 'step 6 ready refused by kernel\n\nGreptile scored it 3/5\n\nspans:\n  - greptile:3/5\n')
  return { db, home, sha }
}

test('D1 D2: a rule on a Greptile stop accepts its open ids', async () => {
  const { db, home, sha } = greptileStop()
  put(home, 7, 'rulings.md', '# Rulings\n')
  await run(db, home, '---\nmove: rule\nwhy: the SDK settles it\nanswer: the SDK   refuses it upstream\n---\n')
  expect(maybe(home, 7, 'rulings.md')).toBe(
    `# Rulings\n\naccepted:\n  head: ${sha.slice(0, 12)}\n  ids: G11, G12\n  reason: the SDK refuses it upstream\n`)
  expect(unruled(home, 7, sha).open).toEqual([])
  expect(maybe(home, 7, 'issue.md')).toContain('## Answer from the director')
  expect(row(db)).toMatchObject({ step: 6, state: 'queued' })
  expect(ofKind(db, 'return').map((e) => e.message)).toEqual(['step 6'])
})

test('D3: a rails stop or no open ids writes no rulings.md', async () => {
  const rails = seeded('1')
  await run(rails.db, rails.home, REPLY.rule ?? '')
  expect(maybe(rails.home, 7, 'rulings.md')).toBeNull()
  for (const findings of [null, `- G11 <img alt="P3" src="x"> a nit\n`]) {
    const { db, home, sha } = greptileStop()
    if (findings === null) drop(home, 7, `findings-${sha}.md`)
    else put(home, 7, `findings-${sha}.md`, findings)
    await run(db, home, REPLY.rule ?? '')
    expect(maybe(home, 7, 'rulings.md')).toBeNull()
    expect(row(db).step).toBe(2)
  }
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

const WHY = 'rewrite commit.msg to name plan 7 and its ticket. '.repeat(5).trim()
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

test('secondFixToCoo', async () => {
  const { db, home } = seeded('1')
  const fix = `---\nmove: fix\nwhy: |\n  rewrite commit.msg to name plan 7.\n${BLOCK.replace(/^/gm, '  ')}\n---\n`
  await cooLite(db, home, row(db), inTurn([fix, fix], []), now, () => undefined, wire())
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo',
    held_why: expect.stringMatching(/^fix did not apply, the fixer did not make the fix:/) as string })
  expect(heldBy(db, 'coo').map((p) => p.id)).toContain(7)
  expect(heldBy(db, 'ceo').map((p) => p.id)).not.toContain(7)
  expect(ofKind(db, 'needs_ceo')).toEqual([])
  const classed = seeded('1')
  await cooLite(classed.db, classed.home, row(classed.db), inTurn([FIX, askCeo(BLOCK)], []), now, () => undefined, wire())
  expect(plan7(classed.db)).toMatchObject({ held_by: 'ceo' })
})

test('code out of reach goes to the builder', async () => {
  const { db, home } = seeded('1')
  fixLive(db)
  await cooLite(db, home, row(db), bySeat([], '---\nmove: fix\nwhy: edit src/sequencer/x.ts to drop the guard\n---\n'), now, () => undefined, wire())
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: expect.stringMatching(/^rule: edit src\/sequencer\/x\.ts/) as string }])
})

test('fixOutOfReach', async () => {
  const outside = (path: string) => `\`${path}\` is outside the fixer's write_paths`
  for (const [why, reason] of [
    ['run gh issue create for the gap', 'the fixer has no git and no GitHub'],
    ['run UPDATE plans SET step = 2 in cf.db', outside('cf.db')],
  ] as const) {
    const { db, home } = seeded('1')
    fixLive(db)
    const was = plans(db)
    const packets: Packet[] = []
    await cooLite(db, home, row(db), bySeat(packets, `---\nmove: fix\nwhy: ${why}\n---\n`), now, () => undefined, wire())
    expect(packets.map((p) => p.prompt.includes(`# Fence\n\nfix is refused: ${reason}. The fixer writes only issue.md`)))
      .toEqual([false, true])
    expect(decisions(db, 7)).toEqual([])
    expect(plans(db)).toEqual(was)
    expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_ceo', message: `fix: refused by the fence, ${reason}` }])
  }
  const { db, home } = seeded('1')
  fixLive(db)
  mkdirSync(join(srcDir(home, 7), '.git'), { recursive: true })
  const packets: Packet[] = []
  await cooLite(db, home, row(db), bySeat(packets, '---\nmove: fix\nwhy: rewrite `commit.msg`.\n---\n'), now, () => undefined, wire())
  expect(packets.filter((p) => basename(p.transcript).startsWith('fixer'))).toHaveLength(1)
  expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
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

const QUESTION = 'which greeting does the banner use?'
const LINE = 'the banner greets with hello, not hi'

function asked(ask: string) {
  const seed = seeded('1')
  seed.db.exec('DELETE FROM runs; UPDATE plans SET step = 1 WHERE id = 7')
  held(seed.db, 7, 'coo', `brief_writer: ${QUESTION}`)
  drop(seed.home, 7, 'refusal.md')
  put(seed.home, 7, 'question.md', `${QUESTION}\n`)
  put(seed.home, 7, 'ask.md', ask)
  return seed
}

const reader: Provider = { ...stub(''), fire: (p) =>
  stub(p.prompt.includes(`# Stop\n\n${QUESTION}`) && p.prompt.includes(`# Ask\n\nthe ask\n\n${LINE}`)
    ? `---\nmove: rule\nwhy: ask.md answers it\nanswer: ${LINE}\n---\n` : ASK_COO).fire(p) }

test('D2: a question ask.md answers is ruled, back at step 1', async () => {
  const { db, home } = asked(`the ask\n\n${LINE}\n`)
  await cooLite(db, home, row(db), reader, now, () => undefined, wire())
  const day = new Date().toISOString().slice(0, 10)
  expect(maybe(home, 7, 'ask.md')).toBe(`the ask\n\n${LINE}\n\n## Answer from the director (${day})\n\n${LINE}\n`)
  expect(row(db)).toMatchObject({ state: 'queued', step: 1 })
  expect(heldBy(db, 'coo').map((p) => p.id)).not.toContain(7)
})

test('D3: a question the ticket leaves open stays with the coo', async () => {
  const { db, home } = asked('the ask\n')
  await cooLite(db, home, row(db), reader, now, () => undefined, wire())
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_ceo',
    message: 'ask_coo: refused by the fence, 0 failed fixes on this stop' }])
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(heldBy(db, 'coo').map((p) => p.id)).toContain(7)
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
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
  expect(posted).toHaveLength(1)
  expect(wokeTold(db).at(-1)).toEqual({ outcome: 'pass', message: 'left alone: plan is running, waiting on ready_proof' })
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toBe('step 4 ready_proof')
})

test('ceilingOnce', async () => {
  const { db, home } = seeded('1')
  db.exec(`DELETE FROM refusals WHERE plan = 7; UPDATE plans SET wait_reason = 'token_ceiling' WHERE id = 7;
    UPDATE settings SET value = '4600' WHERE key = 'plan.token_ceiling'`)
  expect(overBudget(db, 7)).toEqual({ spent: 4600, ceiling: 4600 })
  await run(db, home, REPLY.waive ?? '')
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'waive: the builder can fix the name' }])
  expect(row(db).state).not.toBe('blocked_on_ceo')
  expect(overBudget(db, 7)).toBeNull()
  db.exec(`UPDATE runs SET at = datetime('now', '+1 minute');
    UPDATE plans SET state = 'blocked_on_ceo', held_by = 'coo', wait_reason = 'token_ceiling' WHERE id = 7`)
  const fires: string[] = []
  const posted: string[] = []
  await cooLite(db, home, row(db), wokeStub(REPLY.waive ?? '', fires), now, (t) => void posted.push(t), wire())
  expect(fires).toEqual([])
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'ceo' })
  expect(heldBy(db, 'ceo').map((p) => p.id)).toContain(7)
  expect(decisions(db, 7)).toEqual([expect.objectContaining({ verb: 'ask_ceo', wait_reason: 'token_ceiling',
    why: expect.stringMatching(/^class 1/) as string })])
  expect(told(db).at(-1)).toMatchObject({ outcome: 'needs_ceo', message: expect.stringMatching(/^ask_ceo: class 1/) as string })
  expect(posted).toHaveLength(1)
  await woke(db, home, wokeStub(REPLY.waive ?? '', fires), now, () => undefined, wire())
  expect(await byHand(db, home, wokeStub(REPLY.waive ?? '', fires), now, () => undefined, wire())).toBe('no stopped plan')
  expect(fires).toEqual([])
})

const WIDEN = '---\nmove: widen\nwhy: the wake pipe is full\n---\n'
const widths = (db: Db) => ({ cap: cap(db), dial: setting(db, 'lanes.dial'), ceiling: setting(db, 'lanes.ceiling') })
const widened = (db: Db) => decisions(db, 7).filter((d) => d.verb === 'widen')

test('widenMove', async () => {
  const { db, home } = seeded('1')
  const was = widths(db)
  await run(db, home, WIDEN)
  expect(pipeOf(db, 9).max_concurrent).toBe(2)
  expect(widened(db)).toEqual([{ plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'widen', why: 'the wake pipe is full',
    evidence: 'wake width 1 → 2', tokens: 0 }])
  expect(row(db).state).toBe('queued')
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'widen: the wake pipe is full' }])
  expect(widths(db)).toEqual(was)
  const full = seeded('1')
  width(full.db, 9, 8)
  await run(full.db, full.home, WIDEN)
  expect(pipeOf(full.db, 9).max_concurrent).toBe(8)
  expect(widened(full.db)).toEqual([])
  expect(plan7(full.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(full.db).map((t) => t.message)).toEqual([expect.stringMatching(/^widen did not apply, the pipe is already 8 wide/)])
  const shadow = seeded(null)
  await run(shadow.db, shadow.home, WIDEN)
  expect(pipeOf(shadow.db, 9).max_concurrent).toBe(1)
  expect(widened(shadow.db)).toEqual([])
})

const SAME = 'e'.repeat(64)
const three = (print: string): [number, string, number][] => [[8, print, 3], [10, print, 2], [7, print, 1]]

function alikeStops(apply: string | null, prints: readonly (readonly [number, string, number])[]) {
  const seed = seeded(apply)
  for (const id of [8, 10]) {
    putPlan(seed.db, { id, pipe_id: 9, target_id: null, template: 'pr_path', state: 'blocked_on_ceo', queued_at: '2026-09-24', step: 4,
      retries: 0, lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/caliperforge/caliperforge/issues/${String(id + 140)}` })
  }
  for (const [plan, print, hours] of prints) {
    const at = new Date(now.getTime() - hours * 3_600_000).toISOString()
    seed.db.exec(`INSERT INTO refusals (plan, step, fingerprint, blip, at) VALUES (${String(plan)}, 4, '${print}', 0, '${at}')`)
  }
  return seed
}

test('repeatFilesTicket', async () => {
  const { db, home } = alikeStops('1', three(SAME))
  const bodies: string[] = []
  const fires: string[] = []
  const url = 'https://github.com/caliperforge/caliperforge/issues/900'
  const waits = (id: number) => planRows(db).find((p) => p.id === id)?.waits_on
  await cooLite(db, home, row(db), wokeStub(REPLY.ask_ceo ?? '', fires), now, () => undefined, filing(bodies))
  const ticket = allPlans(db).find((p) => p.origin === url)?.id
  expect(bodies).toEqual([expect.stringMatching(/^Filed by director: plans 7, 8, 10 stopped at step 4 with refusal e{64} within a day\./)])
  expect(waits(7)).toBe(ticket)
  expect(fires).toEqual([])
  await cooLite(db, home, planById(db, 10), wokeStub(REPLY.ask_ceo ?? '', fires), now, () => undefined, filing(bodies))
  expect(bodies).toHaveLength(1)
  expect(waits(10)).toBe(ticket)
  expect(fires).toEqual([])
  expect(told(db).map((t) => t.message)).toEqual(Array(2).fill('file: the same stop on 3 plans within a day'))
  expect(pointers(db, 'director')).toEqual([url, url])
  for (const [apply, prints] of [['1', [[8, SAME, 2], [7, SAME, 1]]], ['1', [[8, SAME, 25], [10, SAME, 2], [7, SAME, 1]]],
    ['1', three(fingerprint(4, ['base:stale']))], [null, three(SAME)]] as const) {
    const quiet = alikeStops(apply, prints)
    const filed: string[] = []
    const fired: string[] = []
    await cooLite(quiet.db, quiet.home, row(quiet.db), wokeStub(REPLY.ask_ceo ?? '', fired), now, () => undefined, filing(filed))
    expect(filed).toEqual([])
    expect(fired).toHaveLength(1)
  }
})

test('the store takes blocked_on_ceo, refuses an unknown reason',() => {
  const { db } = wokeSeeded()
  const insert = (reason: string) => db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why)
    VALUES (7, 4, ?, 'ask_coo', 'x')`).run(reason)
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
})

test('a plan waiting on fork CI is left alone', async () => {
  const { db, home } = seeded('1')
  db.exec("UPDATE plans SET state = 'running', wait_reason = 'ready_proof' WHERE id = 7")
  const posted: string[] = []
  await cooLite(db, home, row(db), bySeat([]), now, (t) => void posted.push(t), wire())
  expect(told(db).map((t) => t.outcome)).toEqual(['pass'])
  expect(posted).toEqual([])
})

const COVER = 'https://github.com/caliperforge/caliperforge/issues/77'
const DEFECT = 'title: the tick skips fixer.mode\nfiles: sequencer/fixer.ts\nends: a live fixer.mode fires the fixer\n'
const said = (outcome: string, extra = '') => `---\noutcome: ${outcome}\nwhy: the cause\n${extra}---\n`

function found(apply: string | null = '1') {
  const seed = seeded(apply)
  addFinding(seed.db, { name: 'fixer', state: 'off', detail: 'fixer.mode is not live' }, now)
  return seed
}

function filing(bodies: string[]): Wire {
  const base = wire()
  return { ...base, file: (repo, title, body, labels) => { bodies.push(body); return base.file(repo, title, body, labels) } }
}

test.each([
  ['fixed', '', null],
  ['covered', `ref: ${COVER}\n`, COVER],
  ['retire', '', null],
  ['defect', DEFECT, 'https://github.com/caliperforge/caliperforge/issues/900'],
])('D1 D2: %s closes the finding with its ref', async (outcome, extra, ref) => {
  const { db, home } = found()
  const bodies: string[] = []
  await decide(db, home, stub(said(outcome, extra)), now, filing(bodies))
  expect(findings(db)).toMatchObject([{ outcome, why: 'the cause', ref, closed_at: now.toISOString() }])
  expect(bodies).toEqual(outcome === 'defect' ? ['**What:** the tick skips fixer.mode\n**Why:** the cause\n'
    + '**Files:** sequencer/fixer.ts\n**When it ends:** a live fixer.mode fires the fixer\n\n'
    + 'Drift finding 1: fixer is off, fixer.mode is not live'] : [])
})

test('D3: retire drops the fixer entry and keeps the rest', async () => {
  const { db, home } = found()
  const path = join(home, 'rules/registry.yaml')
  const was = readFileSync(path, 'utf8').split('\n')
  await decide(db, home, stub(said('retire')), now, wire())
  const left = readFileSync(path, 'utf8').split('\n')
  const names = (lines: string[]) => lines.filter((l) => l.startsWith('- name: '))
  expect(names(left)).toEqual(names(was).filter((l) => l !== '- name: fixer'))
  expect(names(left)).toEqual(expect.arrayContaining(['- name: director', '- name: rust_review']))
  expect(left.filter((l) => l.startsWith('#'))).toEqual(was.filter((l) => l.startsWith('#')))
})

test('D3: retire cuts an entry from its rules/registry/ file', async () => {
  const { db, home } = seeded('1')
  addFinding(db, { name: 'director_widen', state: 'silent', detail: 'no widen' }, now)
  const path = join(home, 'rules/registry/41-director_widen.yaml')
  const entry = readFileSync(path, 'utf8').trimEnd()
  const fires: string[] = []
  await decide(db, home, wokeStub(said('retire'), fires), now, wire())
  expect(fires[0]).toContain(`# Registry entry\n\n${entry}`)
  expect(existsSync(path)).toBe(false)
  expect(mechanisms(home).map((e) => e.name)).toEqual(mechanisms(repo).map((e) => e.name).filter((n) => n !== 'director_widen'))
  expect(findings(db)).toMatchObject([{ outcome: 'retire', closed_at: now.toISOString() }])
})

test.each([
  { name: 'no outcome', reply: '---\nwhy: the cause\n---\n' },
  { name: 'two outcomes', reply: '---\noutcome: fixed\noutcome: retire\nwhy: the cause\n---\n' },
  { name: 'covered with no ref', reply: said('covered') },
])('D4: $name leaves the finding open', async ({ reply }) => {
  const { db, home } = found()
  await decide(db, home, stub(reply), now, wire())
  expect(findings(db)).toMatchObject([{ outcome: null, closed_at: null }])
  expect(ofKind(db, 'director')).toEqual([{ plan: null, kind: 'director', actor: 'director', outcome: 'needs_ceo',
    message: 'finding 1: no outcome' }])
})

test.each([
  { name: 'a live plan director run', apply: '1', set: (db: Db) => { busy(db, 7, 'director', 'ruling', now) } },
  { name: 'coo_lite.max_daily at 0', apply: '1', set: (db: Db) => {
    addSetting(db, { key: 'coo_lite.max_daily', value: '0', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
  } },
  { name: 'director.apply unset', apply: null, set: () => undefined },
])('D5: $name fires nothing on a finding', async ({ apply, set }) => {
  const { db, home } = found(apply)
  set(db)
  const fires: string[] = []
  await decide(db, home, wokeStub(said('fixed'), fires), now, wire())
  expect(fires).toEqual([])
  expect(findings(db)).toMatchObject([{ closed_at: null }])
})

test('D6: a finding answered today waits a day', async () => {
  const { db, home } = found()
  const fires: string[] = []
  const reply = wokeStub('no fence', fires)
  await decide(db, home, reply, now, wire())
  await decide(db, home, reply, now, wire())
  expect(fires).toHaveLength(1)
  await decide(db, home, reply, new Date(now.getTime() + 86_400_001), wire())
  expect(fires).toHaveLength(2)
})
