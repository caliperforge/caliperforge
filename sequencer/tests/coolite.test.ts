import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import { fill } from '../../cli/digests.ts'
import type { Provider } from '../../providers/kind.ts'
import { retried } from '../../store/holds.ts'
import { migrate, open, type Db } from '../../store/index.ts'
import { held, PlanRow } from '../../store/plans.ts'
import { split } from '../brief.ts'
import { cooLite } from '../coolite.ts'
import { hold, unhold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { parted } from '../split.ts'
import { afresh, maybe, put } from '../workspace.ts'

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
  ask_ceo: '---\nmove: ask_ceo\nwhy: a maintainer outside our org sees this\n---\n',
}

const PARTS = split(SPLIT) ?? []

const TWIN: Record<string, (db: Db, home: string) => void> = {
  rule: (db, home) => void unhold(db, home, 7, 'ceo'),
  waive: (db, home) => { afresh(home, 7, retried(db, 7, 'ceo')) },
  split: (db, home) => {
    parted(db, home, row(db), PARTS, wire())
    db.exec("UPDATE plans SET state = 'done' WHERE id = 7")
  },
  close: (db) => db.exec("UPDATE plans SET state = 'done', wait_reason = NULL WHERE id = 7"),
  file: (db, home) => { hold(db, home, 7, 'filed', now) },
  ask_ceo: (db, home) => {
    hold(db, home, 7, 'a maintainer outside our org sees this', now)
    held(db, 7, 'ceo', 'a maintainer outside our org sees this')
  },
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
  put(home, 7, 'refusal.md', 'step 3 rails refused\n')
  return { db, home }
}

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

test('rule adds the answer to ask.md', async () => {
  const { db, home } = seeded('1')
  await run(db, home, REPLY.rule ?? '')
  expect(maybe(home, 7, 'ask.md')).toBe('the ask\n\n## Answer from the COO\n\nbuild on main, not on plan 8\n')
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

test('close with no pushed deliverable is held by the ceo', async () => {
  const { db, home } = seeded('1')
  db.exec('DELETE FROM deliverables')
  await run(db, home, REPLY.close ?? '')
  expect(db.prepare('SELECT state, held_by FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'ceo' })
})

test('a split parted sends to the ceo is held by the ceo', async () => {
  const { db, home } = seeded('1')
  db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706');
    UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7`)
  await run(db, home, SPLIT)
  expect(db.prepare('SELECT state, held_by FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'ceo' })
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 1 })
})
