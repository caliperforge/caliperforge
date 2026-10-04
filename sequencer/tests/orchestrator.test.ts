import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import type { Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import { woke } from '../coolite.ts'
import { drop, maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-24T12:00:00.000Z')
const ASK_CEO = 'thinking\n\n---\nmove: ask_ceo\nwhy: a maintainer outside our org sees this\nclass: 2\n---\n'
const SAID = 'ask_ceo: a maintainer outside our org sees this'

function seeded() {
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

function stub(text: string, fires: string[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      fires.push(packet.prompt)
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 20, output: 30 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

type Db = ReturnType<typeof open>

function state(db: Db, home: string) {
  const src = srcDir(home, 7)
  return {
    plan: db.prepare('SELECT * FROM plans WHERE id = 7').get(),
    files: readdirSync(src, { recursive: true, encoding: 'utf8' }).map((f) => [f, readFileSync(join(src, f), 'utf8')]),
  }
}

const runs = (db: Db) => db.prepare(`SELECT step, input_tokens, cache_read_tokens, output_tokens FROM runs
  WHERE plan = 7 AND seat = 'coo_lite'`).all()
const told = (db: Db) => db.prepare("SELECT outcome, message FROM events WHERE plan = 7 AND kind = 'coo_lite'").all()
const leases = (db: Db) => db.prepare('SELECT count(*) AS n FROM leases').get()

const blocked = (db: Db, home: string) => {
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\nthe binding is stale\n')
}

test('firesOnStop', async () => {
  const { db, home } = seeded()
  blocked(db, home)
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, stub(ASK_CEO, fires), now, (t) => void posted.push(t))
  await wake()
  expect(runs(db)).toEqual([{ step: 4, input_tokens: 10, cache_read_tokens: 20, output_tokens: 30 }])
  expect(told(db)).toEqual([{ outcome: 'needs_ceo', message: SAID }])
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
  expect(told(db)).toHaveLength(1)
  expect(maybe(home, 7, 'orchestrator.md')).toBe(first)
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\na different finding\n')
  await wake()
  expect(runs(db)).toHaveLength(2)
  expect(told(db)).toHaveLength(2)
  expect(fires[1]).toContain('a different finding')
  expect(fires[1]).toContain(`# Orchestrator\n\n${first}`)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).not.toBe(first.split('\n')[0])
  drop(home, 7, 'refusal.md')
  put(home, 7, 'question.md', 'which helper do I call?\n')
  await wake()
  expect(fires[2]).toContain('# Stop\n\nwhich helper do I call?')
  expect(runs(db)).toHaveLength(3)
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
    db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (7, ?, ?)').run(process.ppid, now.toISOString())
  } },
  { name: 'a reason outside WAKE', leased: 0, set: (db: Db) => db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7") },
])('D3 a plan $name is not woken', async ({ leased, set }) => {
  const { db, home } = seeded()
  set(db, home)
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  await woke(db, home, stub(ASK_CEO, fires), now, (t) => void posted.push(t))
  expect(fires).toEqual([])
  expect(runs(db)).toEqual([])
  expect(told(db)).toEqual([])
  expect(maybe(home, 7, 'orchestrator.md')).toBe(null)
  expect(all(home)).toEqual([])
  expect(posted).toEqual([])
  expect(state(db, home)).toEqual(before)
  expect(leases(db)).toEqual({ n: leased })
})

test('D4 a running plan at its ceiling: one post per head', async () => {
  const { db, home } = seeded()
  const fires: string[] = []
  const posted: string[] = []
  const before = state(db, home)
  const wake = () => woke(db, home, stub(ASK_CEO, fires), now, (t) => void posted.push(t))
  for (let i = 0; i < 2; i += 1) await wake()
  expect(fires).toEqual([])
  expect(runs(db)).toEqual([])
  expect(told(db)).toEqual([{ outcome: 'needs_ceo', message: 'ask_ceo: plan is running, not stopped' }])
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(all(home).map((e) => [e.kind, e.note])).toEqual([['blocked', 'ask_ceo: plan is running, not stopped']])
  expect(maybe(home, 7, 'orchestrator.md')).toBe('step 4 token_ceiling\n\nask_ceo: plan is running, not stopped\n')
  expect(state(db, home)).toEqual(before)
  expect(leases(db)).toEqual({ n: 0 })
  db.exec("UPDATE plans SET wait_reason = 'ready_proof' WHERE id = 7")
  await wake()
  expect(posted).toHaveLength(2)
  expect(told(db)).toHaveLength(2)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toBe('step 4 ready_proof')
})

test('the store takes blocked_on_ceo, refuses an unknown reason',() => {
  const { db } = seeded()
  const insert = (reason: string) => db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why)
    VALUES (7, 4, ?, 'ask_coo', 'x')`).run(reason)
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
})
