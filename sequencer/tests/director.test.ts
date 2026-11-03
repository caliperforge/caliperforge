import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import { heldBy } from '../../cli/brief.ts'
import { all } from '../../cli/inbox.ts'
import { fill } from '../../cli/digests.ts'
import { looked } from '../../cli/look.ts'
import { file, LANE } from '../../cli/plan.ts'
import type { Packet, Provider } from '../../providers/kind.ts'
import { load, Seat } from '../../runner/rules.ts'
import { gates } from '../../store/approvals.ts'
import { decision } from '../../store/ask.ts'
import { appliedOf, decided, decisions, touches, type Decision, type Verb } from '../../store/decisions.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addFinding, addSetting, findings, setting } from '../../store/drift.ts'
import { eventsOf, logged, ofKind, pointers, runAt, runRows, type Event } from '../../store/events.ts'
import { retried, returnToLane } from '../../store/holds.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { cap, width } from '../../store/lanes.ts'
import { held as holding, take } from '../../store/leases.ts'
import { busy } from '../../store/now.ts'
import { addPart } from '../../store/parts.ts'
import { allPlans, held, needsCeo, pipeNamed, pipeOf, planById, planRows, putPlan, requeue, retry } from '../../store/plans.ts'
import { alike, clear, fingerprint, overBudget } from '../../store/refusals.ts'
import { runTokens } from '../../store/runs.ts'
import { gather, question } from '../../templates/research.ts'
import { split } from '../brief.ts'
import { byHand, cooLite, read, woke } from '../director.ts'
import { mechanisms } from '../drift.ts'
import { answer as decide } from '../finding.ts'
import { stop } from '../fixed.ts'
import { FIXES } from '../fixer.ts'
import { hold, unhold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { rule } from '../rule.ts'
import { capped } from '../refusal.ts'
import { parted } from '../split.ts'
import { mapOf } from '../steps.ts'
import { unruled } from '../unruled.ts'
import { afresh, drop, git, headSha, maybe, planDir, put, snapshot, srcDir } from '../workspace.ts'

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

const CARRIES = 'instruction: build on main\nresume at: step 2'

const REPLY: Record<string, string> = {
  rule: `---\nmove: rule\nwhy: the ticket settles it\nanswer: build on main, not on plan 8\n${CARRIES}\n---\n`,
  waive: `---\nmove: waive\nwhy: the builder can fix the name\n${CARRIES}\n---\n`,
  split: SPLIT,
  close: '---\nmove: close\nwhy: the work is on main\n---\n',
  file: '---\nmove: file\nwhy: the tick counts a turn twice\nticket: the tick counts a turn twice\n---\n',
  ask_ceo: askCeo(BLOCK),
  park: '---\nmove: park\nwhy: not worth a build yet\nuntil: 2026-10-01T00:00:00.000Z\n---\n',
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
  park: (db, home) => { hold(db, home, 7, 'not worth a build yet', now, null, new Date('2026-10-01T00:00:00.000Z')) },
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

function queuedOverCap() {
  const seed = seeded('1')
  seed.db.exec("UPDATE plans SET state = 'queued', wait_reason = 'over_cap' WHERE id = 7")
  return seed
}

const run = (db: Db, home: string, reply: string, posted: string[] = []) =>
  cooLite(db, home, row(db), stub(reply), now, (t) => void posted.push(t), wire())

const LONG = { timeout: 90_000 }
const FILED = 'https://github.com/caliperforge/caliperforge/issues/900'
const UNBUILT = 'DELETE FROM runs; UPDATE plans SET step = 1 WHERE id = 7'
const RETURN = '---\nmove: return\nwhy: a one-off blip\n---\n'
const ASK_COO = '---\nmove: ask_coo\nwhy: the coo should pick\n---\n'
const WHY = 'rewrite commit.msg to name plan 7 and its ticket. '.repeat(5).trim()
const FIX = `---\nmove: fix\nwhy: ${WHY}\n---\n`
const ruled = (text: string) => `---\nmove: rule\nwhy: the path settles it\nanswer: ${text}\n${CARRIES}\n---\n`
const ruling = (path: string) => ruled(`read ${path}`)
const DROPPED = ruling('.cf/work/8/ask.md')

function committed(home: string): string {
  const src = srcDir(home, 7)
  git(src, ['init', '-q'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'built'])
  return headSha(src)
}

function inTurn(replies: readonly string[], prompts: string[]): Provider {
  return { ...stub(''), fire: (p) => { prompts.push(p.prompt); return stub(replies[prompts.length - 1] ?? '').fire(p) } }
}

function bySeat(packets: Packet[], reply = FIX, fixer = '---\ndid: renamed the migration\nthen: return\nwhy: the rails find the file now\n---\n'): Provider {
  const coo = stub(reply)
  const fix = stub(fixer)
  return { ...coo, fire: (p) => { packets.push(p); return (basename(p.transcript).startsWith('fixer') ? fix : coo).fire(p) } }
}

const fixLive = (db: Db) => db.exec(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
  VALUES ('fixer.mode', 'live', 'ceo', 'ruling', 't', '2026-09-27')`)

const fixing = (packets: Packet[]) => packets.filter((p) => basename(p.transcript).startsWith('fixer'))

function capStop() {
  const seed = seeded('1')
  capped(seed.db, seed.home, 7, 'the 6th build')
  return seed
}

const targeted = (db: Db) => db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706');
    UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7`)

function filing(bodies: string[]): Wire {
  const base = wire()
  return { ...base, file: (repo, title, body, labels) => { bodies.push(body); return base.file(repo, title, body, labels) } }
}

const prompted = async (db: Db, home: string) => {
  const prompts: string[] = []
  const reply = stub(REPLY.ask_ceo ?? '')
  await cooLite(db, home, row(db), { ...reply, fire: (p) => { prompts.push(p.prompt); return reply.fire(p) } }, now, () => undefined, wire())
  return prompts[0]
}

const MOVES = [...Object.keys(REPLY).map((move) => ({ move, seed: () => seeded('1') })),
  ...['rule', 'waive', 'split', 'park'].map((move) => ({ move, seed: capStop }))]

async function twinned() {
  for (const { move, seed } of MOVES) {
    const live = seed()
    const twin = seed()
    await run(live.db, live.home, REPLY[move] ?? '')
    TWIN[move]?.(twin.db, twin.home)
    expect(plan7(live.db)).toEqual(plan7(twin.db))
    expect(told(live.db)).toEqual([{ actor: 'director', outcome: move ==='ask_ceo' ? 'needs_coo' : 'pass', message: expect.stringMatching(new RegExp(`^${move}: `)) as string }])
  }
}

async function shadowed() {
  for (const apply of [null, '0']) {
    for (const [move, reply] of Object.entries(REPLY)) {
      const { db, home } = seeded(apply)
      addSetting(db, { key: 'coo_lite.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
      const was = plans(db)
      const posted: string[] = []
      await run(db, home, reply, posted)
      expect(plans(db)).toEqual(was)
      expect(posted).toEqual([])
      expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'director', note: expect.stringMatching(new RegExp(`^proposes ${move}: `)) as string })
      expect(told(db).map((t) => t.outcome)).toEqual(['needs_coo'])
    }
  }
}

async function unappliable() {
  for (const { queued, reply } of [
    { queued: true, reply: REPLY.rule ?? '' },
    { queued: false, reply: 'I would rule on it.' },
    { queued: false, reply: '---\nmove: rule\nwhy: settled\n---\n' },
    { queued: false, reply: '---\nmove: file\nwhy: a bug\n---\n' },
  ]) {
    const { db, home } = seeded('1')
    if (queued) requeue(db, 7, row(db).step)
    const was = plans(db)
    const posted: string[] = []
    await run(db, home, reply, posted)
    expect(plans(db)).toEqual(was)
    expect(told(db).map((t) => t.outcome)).toEqual(['needs_coo'])
    expect(all(home).at(-1)).toMatchObject({ kind: 'blocked', name: 'director' })
    expect(posted).toHaveLength(1)
  }
}

async function pointed() {
  for (const [move, pointer] of [['file', FILED], ['rule', null]] as const) {
    const { db, home } = seeded('1')
    await run(db, home, REPLY[move] ?? '')
    expect(pointers(db, 'director')).toEqual([pointer])
  }
}

describe('applying a move', () => {
  test('a live move leaves plan 7 as its cf call does on a twin', LONG, twinned)
  test('in shadow a move only proposes, in the inbox', LONG, shadowed)
  test('an unappliable reply changes no plan and tells a person', LONG, unappliable)
  test('a live file logs its issue as pointer, a rule logs none', pointed)
})

const answer = () => `## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\nbuild on main, not on plan 8\n\n${CARRIES}\n`

async function landed() {
  const built = seeded('1')
  await run(built.db, built.home, REPLY.rule ?? '')
  expect(maybe(built.home, 7, 'issue.md')).toBe(`# Issue\n\nthe brief\n\n${answer()}\n## Standing\n\n- no forced push\n`)
  expect(maybe(built.home, 7, 'ask.md')).toBe('the ask\n')
  expect(row(built.db).step).toBe(2)
  const live = seeded('1')
  const twin = seeded('1')
  for (const { db } of [live, twin]) db.exec(UNBUILT)
  await run(live.db, live.home, REPLY.rule ?? '')
  unhold(twin.db, twin.home, 7, 'director')
  expect(maybe(live.home, 7, 'ask.md')).toBe(`the ask\n\n${answer()}`)
  expect(plan7(live.db)).toEqual(plan7(twin.db))
  expect(row(live.db).step).toBe(1)
}

const BLOCKED = { 'applies to': 'plan 7, step 2', instruction: 'build on main', files: '`index.ts`', 'resume at': 'step 2', verify: 'npm run test' }
const carried = (tail = '') =>
  `---\nmove: rule\nwhy: the ticket settles it\nanswer: build on main\n${Object.entries(BLOCKED).map(([k, v]) => `${k}: ${v}`).join('\n')}\n${tail}---\n`

async function carries() {
  for (const [key, value] of Object.entries(BLOCKED)) {
    for (const said of [carried(), carried('[\n')]) expect(read(said)).toMatchObject({ [key]: value })
  }
  const { db, home } = seeded('1')
  await run(db, home, carried())
  for (const [key, value] of Object.entries(BLOCKED)) expect(maybe(home, 7, 'issue.md')).toContain(`\n${key}: ${value}\n`)
}

async function unfielded() {
  for (const move of ['rule', 'waive']) {
    for (const field of ['instruction', 'resume at']) {
      const { db, home } = seeded('1')
      const reply = (REPLY[move] ?? '').replace(new RegExp(`^${field}: .*\n`, 'm'), '')
      const prompts: string[] = []
      await cooLite(db, home, row(db), inTurn([reply, reply], prompts), now, () => undefined, wire())
      expect(prompts[1]).toContain(`# Fence\n\n${move} is refused: no ${field}`)
      expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_coo', message: `${move}: refused by the fence, no ${field}` }])
      expect([maybe(home, 7, 'ask.md'), maybe(home, 7, 'issue.md')]).toEqual(['the ask\n', ISSUE])
    }
  }
}

const P2 = '<img alt="P2" src="https://greptile.com/p2.svg">'

function greptileStop() {
  const { db, home } = seeded('1')
  db.exec('UPDATE plans SET step = 6 WHERE id = 7')
  const sha = committed(home)
  put(home, 7, `findings-${sha}.md`, `- G11 ${P2} the empty name is never refused\n- G12 ${P2} the port is unchecked\n`)
  put(home, 7, 'refusal.md', 'step 6 ready refused by kernel\n\nGreptile scored it 3/5\n\nspans:\n  - greptile:3/5\n')
  return { db, home, sha }
}

async function accepts() {
  const { db, home, sha } = greptileStop()
  put(home, 7, 'rulings.md', '# Rulings\n')
  await run(db, home, `---\nmove: rule\nwhy: the SDK settles it\nanswer: the SDK   refuses it upstream\n${CARRIES}\n---\n`)
  expect(maybe(home, 7, 'rulings.md')).toBe(
    `# Rulings\n\naccepted:\n  head: ${sha.slice(0, 12)}\n  ids: G11, G12\n  reason: the SDK refuses it upstream\n`)
  expect(unruled(home, 7, sha).open).toEqual([])
  expect(maybe(home, 7, 'issue.md')).toContain('## Answer from the director')
  expect(row(db)).toMatchObject({ step: 6, state: 'queued' })
  expect(ofKind(db, 'return').map((e) => e.message)).toEqual(['step 6'])
}

async function unaccepted() {
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
}

const elsewhere = () => {
  const at = join(mkdtempSync(join(tmpdir(), 'cf-other-')), 'site.ts')
  writeFileSync(at, '')
  return at
}

const touch = (dir: string, path: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), '')
}

const IN_REACH: { text: (home: string) => string; made?: (home: string) => void }[] = [
  { text: () => 'read /blog/index.html', made: (h) => { touch(srcDir(h, 7), 'blog/index.html') } },
  { text: () => 'read /sequencer/site.ts', made: (h) => { touch(h, 'sequencer/site.ts') } },
  { text: () => `read ${elsewhere()}` },
  { text: () => 'read /..' },
  { text: () => 'read ../runner/index.ts', made: (h) => { touch(h, 'runner/index.ts'); mkdirSync(join(h, 'sequencer')) } },
  { text: () => 'the seat must refuse `../issue.md`' },
  { text: (h) => `read ${relative(srcDir(h, 7), elsewhere())}` },
  { text: () => 'read sequencer/../../../../../../etc/x' },
  { text: () => 'read ..//.ssh/id_rsa' },
  { text: () => 'read ..//blog/index.html', made: (h) => {
    touch(srcDir(h, 7), 'blog/index.html')
    mkdirSync(join(srcDir(h, 7), 'sequencer'), { recursive: true })
  } },
]

async function reached() {
  for (const { text, made } of IN_REACH) {
    const { db, home } = seeded('1')
    made?.(home)
    const said = text(home)
    await run(db, home, ruled(said))
    expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'rule: the path settles it' }])
    expect(maybe(home, 7, 'issue.md')).toContain(said)
    expect(plan7(db)?.held_by).not.toBe('coo')
  }
}

async function foreign() {
  const { db, home } = seeded('1')
  await run(db, home, DROPPED)
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
  expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_coo',
    message: 'rule did not apply, the answer names a path a ruling may not carry (.cf/work/8/ask.md): the path settles it' }])
}

const EXTRA = 'cli/extra.ts is outside the files'
const HANDBACK = `${EXTRA}, and the hand-back marks D1 done`

function outsideStop() {
  const seed = seeded('1')
  seed.db.exec('UPDATE plans SET step = 3 WHERE id = 7')
  put(seed.home, 7, 'refusal.md', 'step 3 rails refused by rails\n\nspans:\n  - cli/extra.ts:1 authority.outside_files\n')
  return seed
}

async function outside() {
  const edit = outsideStop()
  await run(edit.db, edit.home, `---\nmove: rule\nwhy: the ask needs it\nanswer: ${HANDBACK}\n${CARRIES}\n---\n`)
  expect(maybe(edit.home, 7, 'issue.md')).toContain(`## Outside the files\n\n- \`cli/extra.ts\` — ${HANDBACK}\n`)
  expect(row(edit.db).step).toBe(2)
  expect(ofKind(edit.db, 'return')).toEqual([])
  const { db, home } = outsideStop()
  await run(db, home, `---\nmove: rule\nwhy: the ask needs it\nanswer: ${EXTRA}\n${CARRIES}\n---\n`)
  expect(row(db).step).toBe(3)
  expect(ofKind(db, 'return').map((e) => e.message)).toEqual(['step 3'])
}

function commenting(comments: [string, number, string][]): Wire {
  return { ...wire(), comment: (repo, no, body) => { comments.push([repo, no, body]) } }
}

async function commented() {
  const { db, home } = seeded('1')
  const comments: [string, number, string][] = []
  await cooLite(db, home, row(db), stub(REPLY.rule ?? ''), now, () => undefined, commenting(comments))
  expect(maybe(home, 7, 'issue.md')).toContain('build on main, not on plan 8')
  expect(comments).toEqual([['caliperforge/caliperforge', 139, 'Ruled by director on plan 7.\n\nbuild on main, not on plan 8']])
  for (const { reply, origin } of [{ reply: DROPPED, origin: true }, { reply: REPLY.rule ?? '', origin: false }]) {
    const quiet = seeded('1')
    if (!origin) targeted(quiet.db)
    const none: [string, number, string][] = []
    await cooLite(quiet.db, quiet.home, row(quiet.db), stub(reply), now, () => undefined, commenting(none))
    expect(told(quiet.db).map((t) => t.outcome)).toEqual([origin ? 'needs_coo' : 'pass'])
    expect(none).toEqual([])
  }
}

async function pinned() {
  const { db, home } = seeded('1')
  put(home, 7, 'refusal.md', 'which keys does upstream config.toml take?\n')
  const keys = `github.com/o/r@${'a'.repeat(40)} config.toml: name, port`
  const reply = stub(`---\nmove: rule\nwhy: the pinned read settles it\nanswer: ${keys}\n${CARRIES}\n---\n`)
  const packets: Parameters<Provider['fire']>[0][] = []
  const seen: Provider = { ...reply, fire: (p) => { packets.push(p); return reply.fire(p) } }
  await cooLite(db, home, row(db), seen, now, () => undefined, wire())
  expect(packets[0]?.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash(cf look:*)', 'mcp__github__read'])
  expect(basename(packets[0]?.transcript ?? '')).toBe('director.pending.transcript.jsonl')
  expect(Object.keys(packets[0]?.servers ?? {})).toEqual(['github'])
  expect(packets[0]?.prompt).toContain('mcp__github__read')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: 'rule: the pinned read settles it' }])
  const day = new Date().toISOString().slice(0, 10)
  expect(maybe(home, 7, 'issue.md')).toBe(`# Issue\n\nthe brief\n\n## Answer from the director (${day})\n\n${keys}\n\n${CARRIES}\n\n## Standing\n\n- no forced push\n`)
  expect(row(db).step).toBe(2)
}

const LOOK = 'store SELECT input_tokens FROM runs WHERE plan = 7 AND step = 2'
const TOKENS = `---\nmove: rule\nwhy: cf look store read the run\nanswer: plan 7 step 2 took 1000 input tokens\n${CARRIES}\n---\n`

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

async function storeLooked() {
  const { db, home } = tokenStop()
  await cooLite(db, home, row(db), looker(db, home), now, () => undefined, wire())
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'rule: cf look store read the run' }])
  expect(ofKind(db, 'look')).toEqual([{ plan: 7, kind: 'look', actor: 'coo_lite', outcome: 'pass', message: LOOK }])
  expect(maybe(home, 7, 'issue.md')).toContain('plan 7 step 2 took 1000 input tokens')
  expect(plan7(db)?.held_by).not.toBe('ceo')
  const bare = tokenStop()
  const prompt = join(bare.home, 'seats/director/prompt.md')
  writeFileSync(prompt, readFileSync(prompt, 'utf8').replace(/`cf look store[^`]*`/, 'it'))
  fill(bare.home, '2026-09-27')
  await cooLite(bare.db, bare.home, row(bare.db), looker(bare.db, bare.home), now, () => undefined, wire())
  expect(ofKind(bare.db, 'look')).toEqual([])
  expect(plan7(bare.db)).toMatchObject({ held_by: 'ceo' })
}

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
    ? `---\nmove: rule\nwhy: ask.md answers it\nanswer: ${LINE}\n${CARRIES}\n---\n` : ASK_COO).fire(p) }

async function questioned() {
  const { db, home } = asked(`the ask\n\n${LINE}\n`)
  await cooLite(db, home, row(db), reader, now, () => undefined, wire())
  const day = new Date().toISOString().slice(0, 10)
  expect(maybe(home, 7, 'ask.md')).toBe(`the ask\n\n${LINE}\n\n## Answer from the director (${day})\n\n${LINE}\n\n${CARRIES}\n`)
  expect(row(db)).toMatchObject({ state: 'queued', step: 1 })
  expect(heldBy(db, 'coo').map((p) => p.id)).not.toContain(7)
  const left = asked('the ask\n')
  await cooLite(left.db, left.home, row(left.db), reader, now, () => undefined, wire())
  expect(told(left.db)).toEqual([{ actor: 'director', outcome: 'needs_coo',
    message: 'ask_coo: refused by the fence, 0 failed fixes on this stop' }])
  expect(plan7(left.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(heldBy(left.db, 'coo').map((p) => p.id)).toContain(7)
  expect(maybe(left.home, 7, 'ask.md')).toBe('the ask\n')
}

describe('rule', () => {
  test('a rule goes in issue.md when built, in ask.md when not', landed)
  test('a rule carries its fields into issue.md', carries)
  test('a rule or waive with no instruction or resume at is fenced', LONG, unfielded)
  test('a rule on a Greptile stop accepts its open ids', accepts)
  test('a rails stop or no open ids writes no rulings.md', LONG, unaccepted)
  test('a rule naming a path in or out of the repo applies', LONG, reached)
  test('a rule naming .cf/work/8/ask.md is held by the coo', foreign)
  test('an outside-files rule returns to step 2 or step 3', outside)
  test('a rule comments once on the origin, or not at all', LONG, commented)
  test('an upstream-key stop gets the pinned read tool and its keys', pinned)
  test('a token count is ruled only after a cf look store', storeLooked)
  test('a question is ruled from ask.md, or left with the coo', questioned)
})

async function written() {
  const { db, home } = seeded('1')
  await run(db, home, REPLY.waive ?? '')
  expect(maybe(home, 7, 'issue.md')).toBe(
    `# Issue\n\nthe brief\n\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${CARRIES}\n\n## Standing\n\n- no forced push\n`)
}

const DESIGNED = 'step 4 review refused by code_quality\n\ndesign: no screen served\n\nspans:\n  (none named)\n'

async function designed() {
  const { db, home } = seeded('1')
  for (let i = 0; i < 2; i++) {
    db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
    put(home, 7, 'refusal.md', DESIGNED)
    await run(db, home, REPLY.waive ?? '')
  }
  expect(maybe(home, 7, 'rulings.md')).toBe('\ndesign waived: the builder can fix the name\n')
  expect(told(db).map((t) => t.message)).toEqual(['waive: the builder can fix the name', 'waive: the builder can fix the name'])
}

async function unwaived() {
  const rails = seeded('1')
  await run(rails.db, rails.home, REPLY.waive ?? '')
  expect(maybe(rails.home, 7, 'rulings.md')).toBeNull()
  const { db, home } = seeded('1')
  put(home, 7, 'refusal.md', DESIGNED)
  requeue(db, 7, row(db).step)
  await run(db, home, REPLY.waive ?? '')
  expect(told(db).map((t) => t.outcome)).toEqual(['needs_coo'])
  expect(maybe(home, 7, 'rulings.md')).toBeNull()
}

function staleStop(step5: 'pass' | 'refuse') {
  const { db, home } = seeded('1')
  db.exec('UPDATE plans SET step = 6 WHERE id = 7')
  put(home, 7, 'refusal.md', 'step 3 rails refused by pre_review\n')
  committed(home)
  const tree = snapshot(srcDir(home, 7))
  for (const [step, gate, outcome] of [[4, 'review', 'pass'], [5, 'senior_review', step5]] as const) {
    db.exec(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree)
      VALUES ('${gate}', 'review', '${'d'.repeat(64)}', 7, ${String(step)}, '${outcome}', 'ruling', 'reviewers.verdict', 0, 0, '${tree}')`)
  }
  return { db, home }
}

const builds = (db: Db) => runRows(db).filter((r) => r.plan === 7 && r.step === 2).length

async function resumes() {
  const { db, home } = staleStop('pass')
  const was = builds(db)
  await run(db, home, REPLY.waive ?? '')
  expect(row(db)).toMatchObject({ step: 6, state: 'queued' })
  expect(maybe(home, 7, 'refusal.md')).toBeNull()
  expect(maybe(home, 7, 'refusal.prev.md')).toBe('step 3 rails refused by pre_review\n')
  expect(builds(db)).toBe(was)
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'waive: the builder can fix the name' }])
  const refused = staleStop('refuse')
  const moved = staleStop('pass')
  writeFileSync(join(srcDir(moved.home, 7), 'late.ts'), 'export {}\n')
  for (const stale of [refused, moved]) {
    await run(stale.db, stale.home, REPLY.waive ?? '')
    expect(row(stale.db).step).toBe(2)
    expect(ofKind(stale.db, 'retry').map((e) => e.message)).toEqual(['step 2'])
  }
}

async function ceilinged() {
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
  expect(told(db).at(-1)).toMatchObject({ outcome: 'needs_coo', message: expect.stringMatching(/^ask_ceo: class 1/) as string })
  expect(posted).toHaveLength(1)
  await woke(db, home, wokeStub(REPLY.waive ?? '', fires), now, () => undefined, wire())
  expect(await byHand(db, home, wokeStub(REPLY.waive ?? '', fires), now, () => undefined, wire())).toBe('no stopped plan')
  expect(fires).toEqual([])
}

describe('waive', () => {
  test('a waive writes its block into issue.md', written)
  test('a waive on a design stop writes one waiver line', designed)
  test('a waive on a rails stop or a queued plan writes nothing', unwaived)
  test('a waive on a stale stop resumes step 6, else builds', LONG, resumes)
  test('a second token ceiling after a waive goes to the ceo', ceilinged)
})

async function returned() {
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
}

const escalated = (db: Db) => logged(db, { plan: 7, kind: 'ready', actor: 'kernel', outcome: 'escalate', pointer: null, run: null,
  message: 'Greptile was asked 3 times on this job; asking again at abc is the COO\'s call' })

async function quota() {
  const { db, home } = seeded('1')
  db.exec('UPDATE plans SET step = 6 WHERE id = 7')
  escalated(db)
  const unfired: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error(REPLY.rule) } }
  await cooLite(db, home, row(db), unfired, now, () => undefined, wire())
  expect(row(db)).toMatchObject({ state: 'queued', step: 6 })
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'return: Greptile\'s quota is spent, so ready goes on without it' }])
  const past = seeded('1')
  escalated(past.db)
  await run(past.db, past.home, REPLY.ask_ceo ?? '')
  expect(row(past.db)).toMatchObject({ state: 'blocked_on_ceo', step: 4 })
  expect(told(past.db).map((t) => t.message)).not.toContain('return: Greptile\'s quota is spent, so ready goes on without it')
}

async function refenced() {
  const { db, home } = seeded('1')
  await run(db, home, RETURN)
  needsCeo(db, row(db))
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([RETURN, RETURN], prompts), now, () => undefined, wire())
  const why = `the job was already returned on stop ${stop(home, 7)}`
  expect(prompts.map((p) => p.includes(`# Fence\n\nreturn is refused: ${why}. Choose file, park or split.`))).toEqual([false, true])
  expect(told(db).at(-1)).toEqual({ actor: 'director', outcome: 'needs_coo', message: `return: refused by the fence, ${why}` })
  expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
  expect(ofKind(db, 'return')).toHaveLength(1)
}

async function returnedAgain() {
  const { db, home } = seeded('1')
  await run(db, home, RETURN)
  needsCeo(db, row(db))
  put(home, 7, 'refusal.md', 'step 4 review refused\n')
  await run(db, home, RETURN)
  expect(row(db)).toMatchObject({ state: 'queued', step: 4 })
  expect(ofKind(db, 'return')).toHaveLength(2)
}

describe('return', () => {
  test('a return sends the job back to its lane, in shadow not', returned)
  test('a spent Greptile quota returns a step 6 stop to ready', quota)
  test('a second return on the same stop is fenced', refenced)
  test('a return on a different stop applies', returnedAgain)
})

const WIDEN = '---\nmove: widen\nwhy: the wake pipe is full\n---\n'
const widths = (db: Db) => ({ cap: cap(db), dial: setting(db, 'lanes.dial'), ceiling: setting(db, 'lanes.ceiling') })
const widened = (db: Db) => decisions(db, 7).filter((d) => d.verb === 'widen')

async function widens() {
  const { db, home } = seeded('1')
  const was = widths(db)
  await run(db, home, WIDEN)
  expect(pipeOf(db, 99).max_concurrent).toBe(2)
  expect(widened(db)).toEqual([{ plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'widen', why: 'the wake pipe is full',
    evidence: 'wake width 1 → 2', tokens: 0 }])
  expect(row(db).state).toBe('queued')
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'widen: the wake pipe is full' }])
  expect(widths(db)).toEqual(was)
  const full = seeded('1')
  width(full.db, 99, 8)
  await run(full.db, full.home, WIDEN)
  expect(pipeOf(full.db, 99).max_concurrent).toBe(8)
  expect(widened(full.db)).toEqual([])
  expect(plan7(full.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(full.db).map((t) => t.message)).toEqual([expect.stringMatching(/^widen did not apply, the pipe is already 8 wide/)])
  const shadow = seeded(null)
  await run(shadow.db, shadow.home, WIDEN)
  expect(pipeOf(shadow.db, 99).max_concurrent).toBe(1)
  expect(widened(shadow.db)).toEqual([])
  const lane = seeded('1')
  lane.db.exec("UPDATE plans SET wait_reason = 'lane_over_cap' WHERE id = 7")
  await run(lane.db, lane.home, WIDEN)
  expect(pipeOf(lane.db, 99).max_concurrent).toBe(1)
  expect(widened(lane.db)).toEqual([])
  expect(plan7(lane.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(lane.db).map((t) => t.message)).toEqual([expect.stringMatching(/^widen did not apply, .*lane_over_cap/)])
  const pipe = seeded('1')
  pipe.db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7")
  await run(pipe.db, pipe.home, WIDEN)
  expect(pipeOf(pipe.db, 99).max_concurrent).toBe(2)
  const queued = queuedOverCap()
  await run(queued.db, queued.home, WIDEN)
  expect(pipeOf(queued.db, 99).max_concurrent).toBe(2)
  expect(widened(queued.db)).toHaveLength(1)
  expect(row(queued.db).state).toBe('queued')
  expect(told(queued.db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'widen: the wake pipe is full' }])
  expect(ofKind(queued.db, 'return')).toEqual([])
}

describe('widen', () => {
  test('a widen grows the pipe by one, up to 8 wide', LONG, widens)
})

async function handsOff() {
  const { db, home } = seeded('1')
  fixLive(db)
  committed(home)
  const at = stop(home, 7)
  const packets: Packet[] = []
  await cooLite(db, home, row(db), bySeat(packets), now, () => undefined, wire())
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.prompt).toContain(`# Orchestrator\n\nask_coo: ${WHY}`)
  expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
  expect(decisions(db, 7).map((d) => d.evidence)).toEqual([at])
  expect(touches(db, 7, now)).toBe(1)
  expect(row(db).state).toBe('queued')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: `fix: ${WHY}` }])
}

async function handedUp(reply: string, fixer?: string) {
  const { db, home } = seeded('1')
  fixLive(db)
  committed(home)
  const packets: Packet[] = []
  const posted: string[] = []
  await cooLite(db, home, row(db), bySeat(packets, reply, fixer), now, (t) => void posted.push(t), wire())
  return { db, home, packets, posted }
}

async function unmade() {
  const off = seeded('1')
  const packets: Packet[] = []
  const posted: string[] = []
  await cooLite(off.db, off.home, row(off.db), bySeat(packets), now, (t) => void posted.push(t), wire())
  expect(packets.map((p) => p.prompt.includes('# Fixer'))).toEqual([false, true])
  expect(plan7(off.db)).toMatchObject({ held_by: 'coo' })
  expect(posted).toHaveLength(1)
  expect(told(off.db)).toEqual([{ actor: 'director', outcome:'needs_coo', message: expect.stringMatching(/^fix did not apply, /) as string }])
  const live = await handedUp(FIX, '')
  expect(fixing(live.packets)).toHaveLength(2)
  expect(plan7(live.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(live.db).map((t) => t.message)).toEqual([expect.stringMatching(/^fix did not apply, /)])
  expect(live.posted).toHaveLength(1)
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
}

async function toBuilder() {
  const plain = seeded('1')
  fixLive(plain.db)
  await cooLite(plain.db, plain.home, row(plain.db), bySeat([], '---\nmove: fix\nwhy: edit src/sequencer/x.ts to drop the guard\n---\n'), now, () => undefined, wire())
  expect(told(plain.db)).toEqual([{ actor: 'director', outcome: 'pass', message: expect.stringMatching(/^rule: edit src\/sequencer\/x\.ts/) as string }])
  for (const { why, message, step } of [
    { why: HANDBACK, message: `rule: ${HANDBACK} (out of the fixer's reach, so the builder takes it)`, step: 2 },
    { why: EXTRA, message: `rule: ${EXTRA}`, step: 3 },
  ]) {
    const { db, home } = outsideStop()
    fixLive(db)
    await cooLite(db, home, row(db), bySeat([], `---\nmove: fix\nwhy: ${why}\n---\n`), now, () => undefined, wire())
    expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message }])
    expect(row(db).step).toBe(step)
  }
  const notes = seeded('1')
  fixLive(notes.db)
  committed(notes.home)
  const why = 'rewrite issue.md from ~/notes/brief.md'
  await cooLite(notes.db, notes.home, row(notes.db), bySeat([], `---\nmove: fix\nwhy: ${why}\n---\n`), now, () => undefined, wire())
  expect(told(notes.db)).toEqual([{ actor: 'director', outcome: 'pass', message: `rule: ${why} (out of the fixer's reach, so the builder takes it)` }])
  expect(maybe(notes.home, 7, 'issue.md')).toContain(why)
}

async function unbuiltFix() {
  const { db, home } = seeded('1')
  fixLive(db)
  committed(home)
  db.exec('UPDATE plans SET step = 1 WHERE id = 7; UPDATE runs SET step = 1 WHERE plan = 7')
  const packets: Packet[] = []
  await cooLite(db, home, row(db), bySeat(packets, '---\nmove: fix\nwhy: edit src/sequencer/x.ts to drop the guard\n---\n'), now, () => undefined, wire())
  expect(maybe(home, 7, 'ask.md') ?? '').not.toContain('## Answer from the director')
  expect(told(db).filter((t) => t.message.includes('builder takes it'))).toEqual([])
  expect(packets[1]?.prompt).toContain('# Fence\n\nfix is refused:')
}

async function unreachable() {
  const outside = (path: string) => `\`${path}\` is outside the fixer's write_paths`
  for (const [why, reason] of [
    ['run gh issue create for the gap', 'the fixer has no git and no GitHub'],
    ['run UPDATE plans SET step = 2 in cf.db', outside('cf.db')],
    ['rewrite issue.md and `.cf/work/7/refusal.md`', outside('.cf/work/7/refusal.md')],
    ['rewrite `.cf/work/8/ask.md`', outside('.cf/work/8/ask.md')],
    ['add `Fork: acme/widget` to ask.md', outside('acme/widget')],
  ] as const) {
    const { db, home } = seeded('1')
    fixLive(db)
    committed(home)
    const packets: Packet[] = []
    await cooLite(db, home, row(db), bySeat(packets, `---\nmove: fix\nwhy: ${why}\n---\n`), now, () => undefined, wire())
    expect(packets.map((p) => p.prompt.includes(`# Fence\n\nfix is refused: ${reason}. The fixer writes only issue.md`)))
      .toEqual([false, true, false])
    expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
    expect(row(db).state).toBe('queued')
    expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: `fix: refused by the fence, ${reason}` }])
  }
}

async function inReach() {
  for (const why of [() => 'rewrite `commit.msg`.',
    () => '"rewrite issue.md\'s ## Files to list `crates/mcp/src/surfpool/set_token_account.rs`, and commit.msg."',
    (home: string) => {
      const alias = join(mkdtempSync(join(tmpdir(), 'cf-alias-')), 'tick')
      symlinkSync(home, alias)
      return `add the Fork line to ${alias}/.cf/work/7/ask.md`
    },
    () => 'add the Fork line to `.cf/work/7/ask.md`', () => 'add `Fork: caliperforge/skills` to ask.md']) {
    const { db, home } = seeded('1')
    fixLive(db)
    committed(home)
    const packets: Packet[] = []
    await cooLite(db, home, row(db), bySeat(packets, `---\nmove: fix\nwhy: ${why(home)}\n---\n`), now, () => undefined, wire())
    expect(fixing(packets)).toHaveLength(1)
    expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
  }
}

async function handed() {
  for (const reply of ['I would rule on it.', DROPPED]) {
    const { db, home, packets, posted } = await handedUp(reply)
    expect(decisions(db, 7).map((d) => d.verb)).toEqual(['ask_coo'])
    expect(fixing(packets)).toHaveLength(1)
    expect(plan7(db)?.state).toBe('queued')
    expect(plan7(db)?.held_by).not.toBe('coo')
    expect(told(db).map((t) => t.outcome)).toEqual(['pass'])
    expect(posted).toEqual([])
    expect(maybe(home, 7, 'issue.md')).toBe(ISSUE)
  }
}

async function skipped() {
  for (const set of [() => undefined, (db: Db, home: string) => {
    fixLive(db)
    put(home, 7, 'fixes.jsonl', `${JSON.stringify({ at: now.toISOString(), mode: 'live' })}\n`.repeat(FIXES))
  }]) {
    const { db, home } = seeded('1')
    set(db, home)
    const packets: Packet[] = []
    const posted: string[] = []
    await cooLite(db, home, row(db), bySeat(packets, DROPPED), now, (t) => void posted.push(t), wire())
    expect(fixing(packets)).toEqual([])
    expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
    expect(told(db).map((t) => t.outcome)).toEqual(['needs_coo'])
    expect(posted).toHaveLength(1)
  }
  for (const [seed, reply, message] of [[capStop(), RETURN, 'return: refused by the fence, the plan stopped at its build cap'],
    [seeded('0'), 'I would rule on it.', 'ask_ceo: no readable answer']] as const) {
    fixLive(seed.db)
    committed(seed.home)
    const packets: Packet[] = []
    const posted: string[] = []
    await cooLite(seed.db, seed.home, row(seed.db), bySeat(packets, reply), now, (t) => void posted.push(t), wire())
    expect(fixing(packets)).toEqual([])
    expect(decisions(seed.db, 7)).toEqual([])
    expect(told(seed.db)).toEqual([{ actor: 'director', outcome: 'needs_coo', message }])
    expect(posted).toHaveLength(1)
  }
}

async function escalates() {
  const { db, posted } = await handedUp(DROPPED, '---\ndid: nothing\nthen: ask_ceo\nwhy: a person picks the path\n---\n')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(appliedOf(db, 7).at(-1)).toBe('escalated')
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_coo',
    message: 'rule did not apply, the answer names a path a ruling may not carry (.cf/work/8/ask.md): the path settles it' }])
  expect(posted).toHaveLength(1)
}

describe('fix', () => {
  test('a live fix hands the stop and its hash to the fixer', handsOff)
  test('a fix not made goes to the coo once, not to the ceo', LONG, unmade)
  test('a fix beyond the fixer goes to the builder as a rule', LONG, toBuilder)
  test('a fix beyond the fixer at step 1 is refused, not ruled', unbuiltFix)
  test('each reason a fix is out of reach is named in the fence', LONG, unreachable)
  test('a fix on commit.msg, issue.md or ask.md fires the fixer', LONG, inReach)
  test('an unread reply or a dropped rule goes to the fixer', LONG, handed)
  test('the fixer is skipped when off, spent, capped or in shadow', LONG, skipped)
  test('a fixer ask_ceo on a dropped rule holds for the coo', escalates)
})

async function unsplit() {
  const { db, home } = seeded('1')
  targeted(db)
  await run(db, home, SPLIT)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^split did not apply, /)])
  expect(plans(db)).toHaveLength(1)
}

describe('split', () => {
  test('a split that cannot file its parts is held by the coo', unsplit)
})

const closing = (closes: string[][]): Wire =>
  ({ ...wire(), close: (repo, no, sha, comment) => { closes.push([`${repo}#${String(no)}`, sha, comment ?? '']) } })

const closeEvents = (db: Db) => ofKind(db, 'close').map(({ actor, outcome, message }) => ({ actor, outcome, message }))

async function closedOwn() {
  const { db, home } = seeded('1')
  db.exec('DELETE FROM deliverables')
  const closes: string[][] = []
  await cooLite(db, home, row(db), stub(REPLY.close ?? ''), now, () => undefined, closing(closes))
  expect(row(db).state).toBe('refused')
  expect(closeEvents(db)).toEqual([{ actor: 'director', outcome: 'refuse', message: 'the work is on main' }])
  expect(closes).toEqual([['caliperforge/caliperforge#139', '', expect.stringContaining('the work is on main')]])
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'close: the work is on main' }])
}

async function closedForeign() {
  for (const set of [(db: Db) => db.exec("UPDATE plans SET origin = 'https://github.com/acme/kit/issues/706' WHERE id = 7"), targeted]) {
    const { db, home } = seeded('1')
    set(db)
    db.exec('DELETE FROM deliverables')
    const closes: string[][] = []
    await cooLite(db, home, row(db), stub(REPLY.close ?? ''), now, () => undefined, closing(closes))
    expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo' })
    expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^close did not apply, /)])
    expect(closeEvents(db)).toEqual([])
    expect(closes).toEqual([])
  }
}

async function closedPushed() {
  const { db, home } = seeded('1')
  const closes: string[][] = []
  await cooLite(db, home, row(db), stub(REPLY.close ?? ''), now, () => undefined, closing(closes))
  expect(row(db).state).toBe('done')
  expect(closeEvents(db)).toEqual([])
  expect(closes).toEqual([])
}

describe('close', () => {
  test('an unpushed close of our own plan refuses it', closedOwn)
  test('an unpushed close of another repo is held by the coo', closedForeign)
  test('a pushed close ends done with no issue close', closedPushed)
})

async function filedParks() {
  const { db, home } = seeded('1')
  await run(db, home, REPLY.file ?? '')
  expect(plan7(db)?.waits_on).toBe(allPlans(db).find((p) => p.origin === FILED)?.id)
  expect(maybe(home, 7, 'parked.md')).toContain(FILED)
  expect(ofKind(db, 'return')).toEqual([])
}

async function replayed() {
  const { db, home } = seeded('1')
  fixLive(db)
  committed(home)
  db.exec('UPDATE plans SET step = 2 WHERE id = 7')
  put(home, 7, 'refusal.md', 'step 2 build refused\n\nyarn: command not found\n')
  await run(db, home, REPLY.file ?? '')
  const on = plan7(db)?.waits_on
  const packets: Packet[] = []
  await cooLite(db, home, row(db), bySeat(packets), new Date(now.getTime() + 3_600_000), () => undefined, wire())
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', waits_on: on })
  expect(maybe(home, 7, 'parked.md')).toContain(FILED)
  expect(ofKind(db, 'return')).toEqual([])
}

const SAME = 'e'.repeat(64)
const three = (print: string): [number, string, number][] => [[8, print, 3], [10, print, 2], [7, print, 1]]

function alikeStops(apply: string | null, prints: readonly (readonly [number, string, number])[]) {
  const seed = seeded(apply)
  for (const id of [8, 10]) {
    putPlan(seed.db, { id, pipe_id: 99, target_id: null, template: 'pr_path', state: 'blocked_on_ceo', queued_at: '2026-09-24', step: 4,
      retries: 0, lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/caliperforge/caliperforge/issues/${String(id + 140)}` })
  }
  for (const [plan, print, hours] of prints) {
    const at = new Date(now.getTime() - hours * 3_600_000).toISOString()
    seed.db.exec(`INSERT INTO refusals (plan, step, fingerprint, blip, at) VALUES (${String(plan)}, 4, '${print}', 0, '${at}')`)
  }
  return seed
}

async function repeats() {
  const { db, home } = alikeStops('1', three(SAME))
  const bodies: string[] = []
  const fires: string[] = []
  const waits = (id: number) => planRows(db).find((p) => p.id === id)?.waits_on
  await cooLite(db, home, row(db), wokeStub(REPLY.ask_ceo ?? '', fires), now, () => undefined, filing(bodies))
  const ticket = allPlans(db).find((p) => p.origin === FILED)?.id
  expect(bodies).toEqual([expect.stringMatching(/^Filed by director: plans 7, 8, 10 stopped at step 4 with refusal e{64} within a day\./)])
  expect(waits(7)).toBe(ticket)
  expect(fires).toEqual([])
  await cooLite(db, home, planById(db, 10), wokeStub(REPLY.ask_ceo ?? '', fires), now, () => undefined, filing(bodies))
  expect(bodies).toHaveLength(1)
  expect(waits(10)).toBe(ticket)
  expect(fires).toEqual([])
  expect(told(db).map((t) => t.message)).toEqual(Array(2).fill('file: the same stop on 3 plans within a day'))
  expect(pointers(db, 'director')).toEqual([FILED, FILED])
  for (const [apply, prints] of [['1', [[8, SAME, 2], [7, SAME, 1]]], ['1', [[8, SAME, 25], [10, SAME, 2], [7, SAME, 1]]],
    ['1', three(fingerprint(4, ['base:stale']))], [null, three(SAME)]] as const) {
    const quiet = alikeStops(apply, prints)
    const filed: string[] = []
    const fired: string[] = []
    await cooLite(quiet.db, quiet.home, row(quiet.db), wokeStub(REPLY.ask_ceo ?? '', fired), now, () => undefined, filing(filed))
    expect(filed).toEqual([])
    expect(fired).toHaveLength(1)
  }
}

async function sentRound() {
  for (const [kind, hours, files] of [['return', 0.5, 0], ['retry', 0.5, 0], ['return', 2, 1]] as const) {
    const { db, home } = alikeStops('1', three(SAME))
    logged(db, { plan: 7, kind, actor: 'coo', outcome: 'pass', message: kind, pointer: null, run: null },
      new Date(now.getTime() - hours * 3_600_000).toISOString())
    const filed: string[] = []
    const fired: string[] = []
    await cooLite(db, home, row(db), wokeStub(REPLY.ask_ceo ?? '', fired), now, () => undefined, filing(filed))
    expect(filed).toHaveLength(files)
    expect(fired).toHaveLength(1 - files)
  }
}

async function settledAgain() {
  for (const [stops, found] of [[[[7, 1]], null], [[[8, 3], [10, 2]], { step: 4, fingerprint: SAME, plans: [7] }]] as const) {
    const { db, home } = alikeStops('1', three(SAME))
    for (const [plan, hours] of stops) {
      for (const [outcome, late] of [['refuse', 0], ['escalate', 0.5]] as const) {
        logged(db, { plan, kind: 'ruling', actor: 'brief_writer', outcome, message: outcome, pointer: null, run: null },
          new Date(now.getTime() - (hours - late) * 3_600_000).toISOString())
      }
    }
    expect(alike(db, 7, now)).toEqual(found)
    const filed: string[] = []
    const fired: string[] = []
    await cooLite(db, home, row(db), wokeStub(REPLY.ask_ceo ?? '', fired), now, () => undefined, filing(filed))
    expect(filed).toEqual([])
    expect(fired).toHaveLength(1)
  }
}

describe('file', () => {
  test('a file parks the job on the filed plan', filedParks)
  test('a filed job asked again an hour later stays parked', replayed)
  test('the same stop on three plans in a day files one ticket', LONG, repeats)
  test('a plan sent round since its refusal files no repeat', LONG, sentRound)
  test('a refusal its step settled again after is no stop', settledAgain)
})

async function classed() {
  for (const [refused, block] of FAULTS) expect(decision(askCeo(block))).toEqual({ refused })
  expect(decision(`thinking\n\n${askCeo(BLOCK)}`)).toEqual({ block: BLOCK })
  expect(read('---\nmove: ask_ceo\nwhy: which file\n---\n')).toBeNull()
  expect(read('---\nmove: ask_ceo\nwhy: which file\nclass: 5\n---\n')).toBeNull()
  const ceo = seeded('1')
  await run(ceo.db, ceo.home, REPLY.ask_ceo ?? '')
  expect(plan7(ceo.db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'ceo', held_why: 'a maintainer outside our org sees this',
    held_until: null, waits_on: null })
  expect(maybe(ceo.home, 7, 'parked.md')).toBeNull()
  expect(told(ceo.db).map((t) => t.message)).toEqual([`ask_ceo: a maintainer outside our org sees this\n\n${BLOCK}`])
  const { db, home } = seeded('1')
  held(db, 7, 'coo', 'a stop')
  await run(db, home, '---\nmove: ask_ceo\nwhy: which file\n---\n')
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_coo', message: 'ask_ceo: no readable answer' }])
  expect(plan7(db)).toMatchObject({ held_by: 'coo' })
}

async function reasked() {
  for (const [reason, block] of FAULTS.slice(0, 4)) {
    const { db, home } = seeded('1')
    const prompts: string[] = []
    await cooLite(db, home, row(db), inTurn([askCeo(block), REPLY.rule ?? ''], prompts), now, () => undefined, wire())
    expect(prompts.map((p) => p.includes(`# Fence\n\nask_ceo is refused: ${reason}`))).toEqual([false, true])
    expect(plan7(db)).not.toMatchObject({ held_by: 'ceo' })
  }
}

async function refusedTwice() {
  const bad = askCeo(FAULTS[0][1])
  for (const [message, replies] of [
    ['ask_ceo: refused by the fence, no Decide line', [bad, bad]],
    ['ask_coo: refused by the fence, 0 failed fixes on this stop', [bad, ASK_COO]],
    ['ask_ceo: refused by the fence, no Decide line', [ASK_COO, bad]],
  ] as const) {
    const { db, home } = seeded('1')
    const was = plans(db)
    await cooLite(db, home, row(db), inTurn(replies, []), now, () => undefined, wire())
    expect(plans(db)).toEqual(was)
    expect(told(db).map((t) => t.message)).toEqual([message])
  }
}

describe('ask_ceo', () => {
  test('an ask_ceo needs a class and a whole decision block', classed)
  test('an ask_ceo with a faulty block is asked again', LONG, reasked)
  test('a move refused twice leaves the plans as they were', LONG, refusedTwice)
})

const failedFixes = (db: Db, evidence: string) => {
  for (let i = 0; i < 2; i++) decided(db, { plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: 'a fix', evidence, tokens: 0 })
}

async function oneFailed() {
  const { db, home } = seeded('1')
  decided(db, { plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: 'a fix', evidence: stop(home, 7), tokens: 0 })
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([ASK_COO, REPLY.rule ?? ''], prompts), now, () => undefined, wire())
  expect(prompts.map((p) => p.includes('# Fence\n\nask_coo is refused: 1 failed fixes'))).toEqual([false, true])
  expect(told(db)).toEqual([{ actor: 'director', outcome:'pass', message: 'rule: the ticket settles it' }])
}

async function twoFailed() {
  const { db, home } = seeded('1')
  failedFixes(db, stop(home, 7))
  const prompts: string[] = []
  await cooLite(db, home, row(db), inTurn([ASK_COO], prompts), now, () => undefined, wire())
  expect(prompts).toHaveLength(1)
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo', held_why: 'the coo should pick' })
  expect(told(db)).toEqual([{ actor: 'director', outcome:'needs_coo', message: 'ask_coo: the coo should pick' }])
}

async function earlier() {
  const { db, home } = seeded('1')
  failedFixes(db, stop(home, 7))
  put(home, 7, 'refusal.md', 'step 3 rails refused again\n')
  const was = plans(db)
  await cooLite(db, home, row(db), inTurn([ASK_COO, ASK_COO], []), now, () => undefined, wire())
  expect(plans(db)).toEqual(was)
  expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^ask_coo: refused by the fence/)])
}

describe('ask_coo', () => {
  test('ask_coo on one failed fix is fenced, the next move runs', oneFailed)
  test('ask_coo after two failed fixes holds the job for the coo', twoFailed)
  test('failed fixes on an earlier stop do not count', earlier)
})

async function parks() {
  const { db, home } = capStop()
  await run(db, home, REPLY.park ?? '')
  expect(plan7(db)).toMatchObject({ state: 'blocked_on_ceo', held_until: '2026-10-01T00:00:00.000Z' })
  expect(maybe(home, 7, 'parked.md')).toMatch(/^# Held .*\n\nnot worth a build yet\n/)
  expect(read('---\nmove: park\nwhy: not worth a build yet\n---\n')).toBeNull()
}

async function overCap() {
  const { db, home } = seeded('1')
  db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7")
  await run(db, home, REPLY.park ?? '')
  expect(plan7(db)).toMatchObject({ state: 'queued', held_until: null })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(ofKind(db, 'return')).toHaveLength(1)
  const queued = queuedOverCap()
  await run(queued.db, queued.home, REPLY.park ?? '')
  expect(told(queued.db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'park: not worth a build yet' }])
  expect(ofKind(queued.db, 'return')).toEqual([])
  expect(plan7(queued.db)).toMatchObject({ state: 'queued', held_until: null })
  expect(maybe(queued.home, 7, 'parked.md')).toBeNull()
}

const ON_8 = '---\nmove: park\nwhy: parts it reads in plan 8 have not landed\nuntil: 2026-10-01T00:00:00.000Z\n---\n'

function withPlan8(state: 'queued' | 'done') {
  const seed = seeded('1')
  putPlan(seed.db, { id: 8, pipe_id: 99, target_id: null, template: 'pr_path', state, queued_at: '2026-09-24', step: 2, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/140' })
  return seed
}

async function waitsOn8() {
  const live = withPlan8('queued')
  await run(live.db, live.home, ON_8)
  expect(plan7(live.db)).toMatchObject({ waits_on: 8, held_until: null })
  expect(maybe(live.home, 7, 'parked.md')).toContain('waits on plan 8')
  const { db, home } = withPlan8('done')
  await run(db, home, ON_8)
  expect(plan7(db)).toMatchObject({ waits_on: null, held_until: '2026-10-01T00:00:00.000Z' })
}

describe('park', () => {
  test('a park holds the job until its time', parks)
  test('a park on an over_cap job returns it to its lane', overCap)
  test('a park naming plan 8 waits on it only while it is open', waitsOn8)
})

const LINES = `**Question:** how long does a tick take?
**Would be wrong if:** a tick logs no time
**Done when:** the time is measured
**Measure:** time one tick
**Output:** ~/cf_work/7/`
const researched = (lines: string) => `---\nmove: research\nwhy: the ask only measures\nanswer: |\n${lines.replace(/^/gm, '  ')}\n---\n`

async function researching() {
  const { db, home } = seeded('1')
  db.exec(UNBUILT)
  await run(db, home, researched(LINES))
  expect(plan7(db)).toMatchObject({ template: 'research', lane: 'research', pipe_id: pipeNamed(db, 'research')?.id, step: 0, waits_on: null })
  expect(maybe(home, 7, 'ask.md')).toBe(`the ask\n\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${LINES}\n`)
  expect([maybe(home, 7, 'refusal.prev.md'), maybe(home, 7, 'refusal.md')]).toEqual(['step 3 rails refused\n', null])
  expect(question(home, row(db)).outcome).toBe('pass')
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'research: the ask only measures' }])
}

async function measured() {
  const { db, home } = seeded('1')
  db.exec(UNBUILT)
  await run(db, home, researched(LINES.replace(/\n\*\*Output:\*\*.*$/, '')))
  expect(plan7(db)).toMatchObject({ template: 'research', lane: 'research', step: 0, waits_on: null })
  question(home, row(db))
  const src = srcDir(home, 7)
  mkdirSync(src, { recursive: true })
  git(src, ['init', '-q'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base'])
  const prompts: string[] = []
  await gather(db, home, row(db), mapOf('research').at(1), inTurn(['no fence'], prompts))
  expect(prompts.at(-1)).toMatch(/# measurer\n/)
  expect(runRows(db).at(-1)?.seat).toBe('measurer')
}

const UNRESEARCHED = [
  { sql: 'UPDATE plans SET step = 1 WHERE id = 7', lines: LINES },
  { sql: `${UNBUILT}; UPDATE plans SET template = 'research' WHERE id = 7`, lines: LINES },
  { sql: UNBUILT, lines: LINES.replace(/^\*\*Measure:\*\*.*\n/m, '') },
  ...['~/cf_work', '~/cf_work/../x', '/tmp/x'].map((out) => ({ sql: UNBUILT, lines: LINES.replace('~/cf_work/7/', out) })),
  { sql: UNBUILT, lines: LINES.replace(/^\*\*Done when:\*\*.*\n/m, '') },
]

async function unresearched() {
  expect(read('---\nmove: research\nwhy: the ask only measures\n---\n')).toBeNull()
  for (const { sql, lines } of UNRESEARCHED) {
    const { db, home } = seeded('1')
    db.exec(sql)
    const { template, lane, step } = row(db)
    await run(db, home, researched(lines))
    expect(plan7(db)).toMatchObject({ template, lane, step, state: 'blocked_on_ceo', held_by: 'coo' })
    expect(maybe(home, 7, 'ask.md')).toBe('the ask\n')
    expect(told(db).map((t) => t.message)).toEqual([expect.stringMatching(/^research did not apply, /)])
  }
}

describe('research', () => {
  test('research moves an unbuilt plan to the research lane', researching)
  test('a research answer with no Output fires the measurer', measured)
  test('research on a job it cannot take is held by the coo', LONG, unresearched)
})

async function capCarried() {
  const { db, home } = capStop()
  const cap = maybe(home, 7, 'director.md') ?? ''
  expect(cap).toMatch(/^# Build cap\n\nthe 6th build\n/)
  expect(ofKind(db, 'build_cap').map((e) => ({ actor: e.actor, outcome: e.outcome }))).toEqual([{ actor: 'settle', outcome: 'needs_coo' }])
  expect(await prompted(db, home)).toContain(`# Stop\n\nstep 3 rails refused\n\n\n${cap}\n\n# Findings\n\nnone\n\n# Orchestrator`)
  expect(await prompted(db, home)).not.toContain(cap)
}

async function capFenced() {
  for (const [move, reply] of [['return', RETURN], ['fix', FIX], ['ask_ceo', REPLY.ask_ceo ?? '']] as const) {
    const { db, home } = capStop()
    const prompts: string[] = []
    await cooLite(db, home, row(db), inTurn([reply, REPLY.rule ?? ''], prompts), now, () => undefined, wire())
    expect(prompts.map((p) => p.includes(`# Fence\n\n${move} is refused: the plan stopped at its build cap`))).toEqual([false, true])
    expect(told(db)).toEqual([{ actor: 'director', outcome: 'pass', message: 'rule: the ticket settles it' }])
  }
  const { db, home } = capStop()
  const was = plans(db)
  const posted: string[] = []
  await cooLite(db, home, row(db), inTurn([RETURN, RETURN], []), now, (t) => void posted.push(t), wire())
  expect(plans(db)).toEqual(was)
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_coo', message: 'return: refused by the fence, the plan stopped at its build cap' }])
  expect(posted).toHaveLength(1)
}

describe('cap stop', () => {
  test('a cap stop carries director.md after # Stop', capCarried)
  test('a cap stop fences return, fix and ask_ceo', LONG, capFenced)
})

async function rulings() {
  const { db, home } = seeded('1')
  const at = (n: number) => `https://github.com/caliperforge/caliperforge/issues/${String(n)}`
  for (const [id, n] of [[8, 140], [9, 141]] as const) {
    putPlan(db, { id, pipe_id: 99, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-09-24', step: 2, retries: 0,
      lane: 'machine', seat: 'typescript_specialist', origin: at(n) })
  }
  db.exec(`INSERT INTO tickets (repo, number, title, lane, parent) VALUES
    ('caliperforge/caliperforge', 139, '138a one', 'machine', 138),
    ('caliperforge/caliperforge', 140, '138b two', 'machine', 138),
    ('caliperforge/caliperforge', 141, '200a three', 'machine', 200)`)
  put(home, 8, 'ask.md', 'the ask\n\n## Ruling\n\nuse main\n\n## Notes\n\nnot this\n')
  put(home, 9, 'ask.md', 'the ask\n\n## Ruling\n\nuse plan 8\n')
  const prompt = await prompted(db, home)
  expect(prompt).toContain('# Rulings on sibling plans\n\nplan 8, ask.md:\n## Ruling\n\nuse main')
  expect(prompt).not.toContain('not this')
  expect(prompt).not.toContain('use plan 8')
  const own = seeded('1')
  put(own.home, 7, 'rulings.md', 'round 3: write the workflow\n')
  put(own.home, 7, 'issue.md', '# Issue\n\nthe brief\n\n## Ruling\n\nkeep main\n\n## Standing\n\n- no forced push\n')
  expect(await prompted(own.db, own.home)).toContain('# Rulings on this plan\n\nrulings.md:\nround 3: write the workflow\n\nissue.md:\n## Ruling\n\nkeep main\n\n# Rulings on sibling plans')
  const none = seeded('1')
  expect(await prompted(none.db, none.home)).toContain('# Rulings on this plan\n\nnone\n\n# Rulings on sibling plans')
}

async function findingsListed() {
  const { db, home } = greptileStop()
  const tree = 'e'.repeat(40)
  db.exec(`INSERT INTO verdicts (gate, kind, subject_digest, plan, step, outcome, origin_kind, origin_ref, tokens, seconds, tree)
    VALUES ('blind_review', 'review', '${'d'.repeat(64)}', 7, 5, 'refuse', 'ruling', 'reviewers.verdict', 0, 0, '${tree}')`)
  put(home, 7, `findings-${tree}.md`, '- B1 P2 src/a.ts:4 the name is lost\n')
  expect(await prompted(db, home)).toMatch(/# Findings\n\n.+\n\n- G11 .+\n- G12 .+\n- B1 P2 src\/a\.ts:4 the name is lost\n/)
  const none = seeded('1')
  expect(await prompted(none.db, none.home)).toContain('# Findings\n\nnone')
}

async function parented() {
  const { db, home } = seeded('1')
  const parent = file(db, 'coo', LANE.machine.pipe, 'machine', LANE.machine.seat, 'https://github.com/caliperforge/caliperforge/issues/900', 0)
  put(home, parent, 'ask.md', '# parent\n\nseed: coo_lite, fixer\n')
  addPart(db, { parent, n: 0, url: 'https://github.com/caliperforge/caliperforge/issues/901', title: '9a: part', body: 'part body', plan: 7, after: null })
  const prompt = await prompted(db, home)
  expect(prompt).toContain('# Parent ticket\n\n# parent\n\nseed: coo_lite, fixer\n')
  expect(prompt).toMatch(/# Record\n\n\d+ runs, \d+ tokens, \$\d+\.\d\d\n/)
}

describe('packet', () => {
  test('the packet carries own rulings, then sibling ones, or none', LONG, rulings)
  test('the packet lists Greptile then blind findings, or none', findingsListed)
  test('the packet carries the parent ticket and the spend so far', parented)
})

function readsLong() {
  const why = 'the checkout holds only README.md and LICENSE, so the upstream layout cannot be settled here. '.repeat(8).trim()
  const got = read(`reasoning\n\n\`\`\`\n---\nmove: file\nwhy: ${why}\nticket: ${'t'.repeat(200)}\n---\n\`\`\``)
  expect(got).toMatchObject({ move: 'file', why })
  expect(got !== null && 'ticket' in got ? got.ticket?.length : 0).toBe(140)
  expect(read('---\nmove: rule\nwhy: "Desk alarm" means the sign-off card\nanswer: use the card\n---\n'))
    .toMatchObject({ move: 'rule', why: '"Desk alarm" means the sign-off card', answer: 'use the card' })
}

function seatTools() {
  const card = (tools: string[]) => ({ seat: 'director', model: 'm', effort: 'low', tools, write_paths: [] })
  expect(Seat.parse(card(['Read', 'Bash(cf look:*)'])).tools).toEqual(['Read', 'Bash(cf look:*)'])
  for (const tools of [['Read', 'Bash(git:*)'], ['Read', 'Bash(cf look:*)', 'Bash'], ['Read', 'Bash(cf look:x)'], ['Read', 'Bash(cf:*)']]) {
    expect(() => Seat.parse(card(tools))).toThrow(/save Bash\(cf look:\*\)/)
  }
}

describe('reading a reply', () => {
  test('a long or quoted why and a long ticket title still read', readsLong)
  test('a seat with no write_paths may hold only Bash(cf look:*)', seatTools)
})

const clock = new Date()
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)

function stopped(db: Db, id: number, minutes: number, verb: Verb = 'ask_coo') {
  if (!allPlans(db).some((p) => p.id === id)) {
    putPlan(db, { id, pipe_id: 99, target_id: null, template: 'pr_path', state: 'running', queued_at: '2026-09-24', step: 4, retries: 0,
      lane: 'machine', seat: 'typescript_specialist', origin: `https://github.com/caliperforge/caliperforge/issues/${String(id + 900)}` })
    needsCeo(db, planById(db, id))
  }
  decided(db, { plan: id, step: 4, wait_reason: 'blocked_on_ceo', verb, why: 'a stop', evidence: null, tokens: 0 }, ago(minutes))
}

const fires = (db: Db) => runRows(db).filter((r) => r.seat === 'director').map(({ plan }) => ({ plan }))
const pile = (db: Db, home: string, posted: string[] = []) =>
  byHand(db, home, stub(REPLY.ask_ceo ?? ''), clock, (t) => void posted.push(t), wire())

const passed = (db: Db, minutes: number) =>
  logged(db, { plan: 7, kind: 'coo_lite', actor: 'coo_lite', outcome: 'pass', message: 'rule: x', pointer: null, run: null }, ago(minutes))

async function oldest() {
  for (const ages of [[30, 20, 10], [1], [10]]) {
    const { db, home } = seeded('1')
    ages.forEach((m, i) => { stopped(db, 7 + i, m) })
    await pile(db, home)
    expect(fires(db)).toEqual([{ plan: 7 }])
    expect(told(db)).toHaveLength(1)
  }
  const answered = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(answered.db, 7 + i, m)
  logged(answered.db, { plan: 7, kind: 'coo_lite', actor: 'coo_lite', outcome: 'needs_ceo', message: 'x', pointer: null, run: null }, ago(5))
  await pile(answered.db, answered.home)
  expect(fires(answered.db)).toEqual([{ plan: 8 }])
}

async function liveRun() {
  for (const ages of [[[7, 30], [8, 20], [9, 10]], [[7, 10], [9, 5]]] as const) {
    const { db, home } = seeded('1')
    for (const [id, m] of ages) stopped(db, id, m)
    busy(db, 9, 'director', 'ruling', clock)
    expect(await pile(db, home)).toBe('a director run is live')
    expect(fires(db)).toEqual([])
  }
}

async function dayCap() {
  const { db, home } = seeded('1')
  for (const [i, m] of [30, 20, 10].entries()) stopped(db, 7 + i, m)
  load(db, home)
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'director', ago(60 + i))
  expect(await pile(db, home)).toBe('cap reached: 12 director runs today')
  expect(fires(db)).toHaveLength(12)
  expect(told(db)).toEqual([])
  addSetting(db, { key: 'coo_lite.max_daily', value: '13', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
  await pile(db, home)
  expect(fires(db)).toHaveLength(13)
}

async function answeredToday() {
  const once = seeded('1')
  stopped(once.db, 7, 50)
  passed(once.db, 60)
  await pile(once.db, once.home)
  expect(fires(once.db)).toEqual([{ plan: 7 }])
  const { db, home } = seeded('1')
  stopped(db, 7, 50)
  passed(db, 60)
  passed(db, 55)
  const posted: string[] = []
  await pile(db, home, posted)
  await pile(db, home, posted)
  expect(fires(db)).toEqual([])
  expect(told(db).filter((t) => t.outcome === 'needs_coo')).toEqual([{ actor: 'director', outcome:'needs_coo', message: 'ask_coo: director answered this plan twice today' }])
  expect(all(home).filter((e) => e.kind === 'blocked')).toHaveLength(1)
  expect(posted).toHaveLength(1)
}

async function notStops() {
  const { db, home } = seeded('1')
  for (const [i, m] of [60, 60, 60].entries()) stopped(db, 7 + i, m)
  held(db, 7, 'ceo', 'his call')
  hold(db, home, 8, 'parked', clock, null, new Date('2099-01-01T00:00:00Z'))
  stopped(db, 9, 55, 'retry')
  await pile(db, home)
  expect(fires(db)).toEqual([])
  expect(told(db)).toEqual([])
}

describe('by-hand triggers', () => {
  test('by hand, the oldest unanswered stop fires one run', LONG, oldest)
  test('by hand, a live director run fires nothing', liveRun)
  test('by hand, the day cap fires nothing until it is raised', dayCap)
  test('a stop answered once today fires, a third goes to a person', answeredToday)
  test('ceo-held, parked and retried plans are not stops', notStops)
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
    plan: planRows(db).find((r) => r.id === 7),
    files: readdirSync(src, { recursive: true, encoding: 'utf8' }).map((f) => [f, readFileSync(join(src, f), 'utf8')]),
  }
}

const wokeRuns = (db: Db) => runTokens(db, 7).filter((r) => r.seat === 'director').map(({ id, input_tokens, cache_read_tokens, output_tokens }) =>
  ({ step: runRows(db).find((r) => r.id === id)?.step, input_tokens, cache_read_tokens, output_tokens }))
const wokeTold = (db: Db) => eventsOf(db, 7, 'director').map(({ outcome, message }) => ({ outcome, message }))
const leases = (db: Db) => ({ n: holding(db, wokeAt).length })

const blocked = (db: Db, home: string) => {
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\nthe binding is stale\n')
}

async function onStop() {
  const { db, home } = wokeSeeded()
  blocked(db, home)
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, (t) => void posted.push(t))
  await wake()
  expect(wokeRuns(db)).toEqual([{ step: 4, input_tokens: 10, cache_read_tokens: 20, output_tokens: 30 }])
  expect(wokeTold(db)).toEqual([{ outcome: 'needs_coo', message: SAID }])
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
}

const UNWOKEN = [
  { leased: 0, set: (db: Db, home: string) => {
    blocked(db, home)
    db.exec("UPDATE plans SET held_by = 'ceo' WHERE id = 7")
  } },
  { leased: 0, set: (db: Db, home: string) => { blocked(db, home); put(home, 7, 'parked.md', '# Held\n') } },
  { leased: 1, set: (db: Db, home: string) => {
    blocked(db, home)
    take(db, 7, wokeAt, process.ppid)
  } },
  { leased: 0, set: (db: Db) => db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7") },
]

async function unwoken() {
  for (const { leased, set } of UNWOKEN) {
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
  }
}

async function needed() {
  for (const { why, first, blocks } of [
    { why: 'the binding is stale\nmore', first: 'the binding is stale', blocks: [] as string[] },
    { why: `thinking\n${BLOCK}`, first: 'thinking', blocks: [BLOCK] },
  ]) {
    const { db, home } = wokeSeeded()
    blocked(db, home)
    db.exec("UPDATE plans SET held_by = 'ceo' WHERE id = 7")
    needsCeo(db, planById(db, 7), why)
    expect(planRows(db).find((r) => r.id === 7)).toMatchObject({ state: 'blocked_on_ceo', held_by: 'coo', held_why: first })
    expect(ofKind(db, 'needs_ceo').map((e) => [e.outcome, e.message])).toEqual(blocks.map((b) => ['escalate', b]))
    const fires: string[] = []
    await woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, () => undefined)
    expect(fires).toHaveLength(1)
  }
}

async function running() {
  const { db, home } = wokeSeeded()
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, wokeStub(ASK_CEO, fires), wokeAt, (t) => void posted.push(t))
  for (let i = 0; i < 2; i += 1) await wake()
  expect(fires).toEqual([])
  expect(wokeRuns(db)).toEqual([])
  expect(wokeTold(db)).toEqual([{ outcome: 'needs_coo', message: 'ask_ceo: plan is running, not stopped' }])
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
  const fork = seeded('1')
  fork.db.exec("UPDATE plans SET state = 'running', wait_reason = 'ready_proof' WHERE id = 7")
  const quiet: string[] = []
  await cooLite(fork.db, fork.home, row(fork.db), bySeat([]), now, (t) => void quiet.push(t), wire())
  expect(told(fork.db).map((t) => t.outcome)).toEqual(['pass'])
  expect(quiet).toEqual([])
}

const day = new Date('2026-09-24T15:00:00.000Z')
const lookAt = (db: Db, message: string, at: string, outcome: Event['outcome'] = 'pass') =>
  logged(db, { plan: 7, kind: 'director', actor: 'director', outcome, message, pointer: null, run: null }, at)

const LOOKS = [
  { at: '2026-09-24 13:59:00', when: day, priority: 1, fired: 1 },
  { at: '2026-09-24 14:01:00', when: day, priority: 1, fired: 0 },
  { at: '2026-09-24 11:00:00', when: new Date('2026-09-24T12:59:00.000Z'), priority: 1, fired: 0 },
  { at: '2026-09-24 13:59:00', when: new Date('2026-09-25T02:00:00.000Z'), priority: 1, fired: 0 },
  { at: '2026-09-24 13:59:00', when: day, priority: 2, fired: 0 },
]

async function looks() {
  for (const { at, when, priority, fired } of LOOKS) {
    const { db, home } = wokeSeeded()
    blocked(db, home)
    db.exec(`UPDATE plans SET priority = ${String(priority)} WHERE id = 7`)
    put(home, 7, 'orchestrator.md', `step 4 blocked ${stop(home, 7)}\n\n${SAID}\n`)
    lookAt(db, SAID, at)
    const fires: string[] = []
    await woke(db, home, wokeStub(ASK_CEO, fires), when, () => undefined)
    expect(fires).toHaveLength(fired)
  }
}

async function overCapWakes() {
  for (const { priority, fired } of [{ priority: 1, fired: 1 }, { priority: 2, fired: 0 }]) {
    const { db, home } = wokeSeeded()
    db.exec(`UPDATE plans SET state = 'queued', wait_reason = 'over_cap', priority = ${String(priority)} WHERE id = 7`)
    const fires: string[] = []
    await woke(db, home, wokeStub(ASK_CEO, fires), day, () => undefined)
    expect(fires).toHaveLength(fired)
    expect(fires.every((f) => f.includes(', waiting on over_cap\n\n# Stop'))).toBe(true)
    expect(wokeTold(db)).toEqual(fired === 1 ? [{ outcome: 'needs_coo', message: SAID }] : [])
  }
}

const PARKS = [
  { message: 'park: the pipe is full', outcome: 'pass', note: '2026-09-24T13:59:00.400Z', fired: 1 },
  { message: 'park: refused by the fence', outcome: 'needs_coo', note: '2026-09-24T13:59:00.400Z', fired: 0 },
  { message: null, outcome: 'pass', note: '2026-09-24T13:59:00.400Z', fired: 0 },
  { message: 'park: the pipe is full', outcome: 'pass', note: '2026-09-24T13:59:01.000Z', fired: 0 },
] as const

async function parkedBy() {
  for (const { message, outcome, note, fired } of PARKS) {
    const { db, home } = wokeSeeded()
    blocked(db, home)
    put(home, 7, 'parked.md', `# Held ${note}\n`)
    if (message !== null) lookAt(db, message, '2026-09-24 13:59:00', outcome)
    const fires: string[] = []
    await woke(db, home, wokeStub(ASK_CEO, fires), day, () => undefined)
    expect(fires).toHaveLength(fired)
    expect(maybe(home, 7, 'parked.md')).toBe(fired === 1 ? null : `# Held ${note}\n`)
  }
}

describe('wake rules', () => {
  test('a stop wakes the director once until the stop changes', onStop)
  test('a held, parked, leased or night over_cap plan is not woken', LONG, unwoken)
  test('a needs_ceo stop is held by the coo and still wakes', needed)
  test('a running plan posts once per head, a waiting one is left', running)
  test('an unchanged stop is asked again after an hour, P1, by day', LONG, looks)
  test('an over_cap wait wakes by day at P1 only', overCapWakes)
  test('only a stop the director parked itself is woken', LONG, parkedBy)
})

function checked() {
  const { db } = wokeSeeded()
  const insert = (reason: string) => decided(db, { plan: 7, step: 4, wait_reason: reason as Decision['wait_reason'], verb: 'ask_coo',
    why: 'x', evidence: null, tokens: 0 })
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
}

describe('decisions store', () => {
  test('the store takes blocked_on_ceo, refuses an unknown reason', checked)
})

const COVER = 'https://github.com/caliperforge/caliperforge/issues/77'
const DEFECT = 'title: the tick skips fixer.mode\nfiles: sequencer/fixer.ts\nends: a live fixer.mode fires the fixer\n'
const said = (outcome: string, extra = '') => `---\noutcome: ${outcome}\nwhy: the cause\n${extra}---\n`

function found(apply: string | null = '1') {
  const seed = seeded(apply)
  addFinding(seed.db, { name: 'fixer', state: 'off', detail: 'fixer.mode is not live' }, now)
  return seed
}

const CLOSES = [
  ['fixed', '', null, null],
  ['covered', `ref: ${COVER}\n`, COVER, null],
  ['retire', '', FILED, '**What:** Retire registry entry fixer\n**Why:** the cause\n**Files:** rules/registry/01-fixer.yaml\n'
    + '**When it ends:** main no longer has the fixer entry in rules/registry/01-fixer.yaml\n\n'
    + 'Drift finding 1: fixer is off, fixer.mode is not live'],
  ['defect', DEFECT, FILED, '**What:** the tick skips fixer.mode\n**Why:** the cause\n'
    + '**Files:** sequencer/fixer.ts\n**When it ends:** a live fixer.mode fires the fixer\n\n'
    + 'Drift finding 1: fixer is off, fixer.mode is not live'],
] as const

async function outcomes() {
  for (const [outcome, extra, ref, body] of CLOSES) {
    const { db, home } = found()
    const bodies: string[] = []
    await decide(db, home, stub(said(outcome, extra)), now, filing(bodies))
    expect(findings(db)).toMatchObject([{ outcome, why: 'the cause', ref, closed_at: now.toISOString() }])
    expect(bodies).toEqual(body === null ? [] : [body])
  }
}

async function retires() {
  const kept = found()
  await decide(kept.db, kept.home, stub(said('retire')), now, wire())
  expect(existsSync(join(kept.home, 'rules/registry/01-fixer.yaml'))).toBe(true)
  expect(mechanisms(kept.home)).toEqual(mechanisms(repo))
  const { db, home } = seeded('1')
  addFinding(db, { name: 'director_widen', state: 'silent', detail: 'no widen' }, now)
  const path = join(home, 'rules/registry/41-director_widen.yaml')
  const entry = readFileSync(path, 'utf8').trimEnd()
  const fires: string[] = []
  await decide(db, home, wokeStub(said('retire'), fires), now, wire())
  expect(fires[0]).toContain(`# Registry entry\n\n${entry}`)
  expect(readFileSync(path, 'utf8').trimEnd()).toBe(entry)
  expect(mechanisms(home)).toEqual(mechanisms(repo))
  expect(findings(db)).toMatchObject([{ outcome: 'retire', ref: FILED, closed_at: now.toISOString() }])
}

async function unclosed() {
  const { db, home } = seeded('1')
  addFinding(db, { name: 'gone', state: 'off', detail: 'no entry' }, now)
  const bodies: string[] = []
  await decide(db, home, stub(said('retire')), now, filing(bodies))
  expect(bodies).toEqual([])
  expect(findings(db)).toMatchObject([{ outcome: null, closed_at: null }])
  expect(told(db)).toEqual([{ actor: 'director', outcome: 'needs_coo', message: 'retire did not apply: no entry gone' }])
  for (const reply of ['---\nwhy: the cause\n---\n', '---\noutcome: fixed\noutcome: retire\nwhy: the cause\n---\n', said('covered')]) {
    const seed = found()
    await decide(seed.db, seed.home, stub(reply), now, wire())
    expect(findings(seed.db)).toMatchObject([{ outcome: null, closed_at: null }])
    expect(ofKind(seed.db, 'director')).toEqual([{ plan: null, kind: 'director', actor: 'director', outcome: 'needs_coo',
      message: 'finding 1: no outcome' }])
  }
}

async function unfired() {
  for (const { apply, set } of [
    { apply: '1', set: (db: Db) => { busy(db, 7, 'director', 'ruling', now) } },
    { apply: '1', set: (db: Db) => {
      addSetting(db, { key: 'director.findings_daily', value: '0', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
    } },
    { apply: null, set: () => undefined },
  ]) {
    const { db, home } = found(apply)
    set(db)
    const fires: string[] = []
    await decide(db, home, wokeStub(said('fixed'), fires), now, wire())
    expect(fires).toEqual([])
    expect(findings(db)).toMatchObject([{ closed_at: null }])
  }
}

async function daily() {
  const { db, home } = found()
  const fires: string[] = []
  const reply = wokeStub('no fence', fires)
  await decide(db, home, reply, now, wire())
  await decide(db, home, reply, now, wire())
  expect(fires).toHaveLength(1)
  await decide(db, home, reply, new Date(now.getTime() + 86_400_001), wire())
  expect(fires).toHaveLength(2)
}

describe('drift findings', () => {
  test('each outcome closes the finding with its ref', LONG, outcomes)
  test('a retire files a ticket and keeps the registry entry', retires)
  test('a finding with no entry or no single outcome stays open', LONG, unclosed)
  test('a live run, a zero daily cap or shadow fires no finding', LONG, unfired)
  test('a finding answered today waits a day', daily)
})
