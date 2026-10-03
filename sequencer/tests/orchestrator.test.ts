import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import { woke } from '../orchestrator.ts'
import { maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-24T12:00:00.000Z')
const ASK_CEO = 'thinking\n\n---\nmove: ask_ceo\nwhy: a maintainer outside our org sees this\nclass: 2\n---\n'

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

const runs = (db: Db) => db.prepare("SELECT seat FROM runs WHERE plan = 7 AND seat = 'coo_lite'").all()
const told = (db: Db) => db.prepare("SELECT message FROM events WHERE plan = 7 AND kind = 'coo_lite'").all()

const blocked = (db: Db, home: string) => {
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\nthe binding is stale\n')
}

test('firesOnStop', async () => {
  const { db, home } = seeded()
  blocked(db, home)
  const fires: string[] = []
  await woke(db, home, stub(ASK_CEO, fires), now, () => undefined)
  expect(runs(db)).toEqual([{ seat: 'coo_lite' }])
  expect(told(db)).toHaveLength(1)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toMatch(/^step 4 blocked [0-9a-f]{12}$/)
  expect(db.prepare('SELECT count(*) AS n FROM leases').get()).toEqual({ n: 0 })
  await woke(db, home, stub(ASK_CEO, fires), now, () => undefined)
  expect(fires).toHaveLength(1)
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\na different finding\n')
  await woke(db, home, stub(ASK_CEO, fires), now, () => undefined)
  expect(runs(db)).toHaveLength(2)
})

test.each([
  { name: 'held by the ceo', set: (db: Db, home: string) => { blocked(db, home); db.exec("UPDATE plans SET held_by = 'ceo' WHERE id = 7") } },
  { name: 'parked', set: (db: Db, home: string) => { blocked(db, home); put(home, 7, 'parked.md', '# Held\n') } },
  { name: 'leased by another live tick', set: (db: Db, home: string) => {
    blocked(db, home)
    db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (7, ?, ?)').run(process.ppid, now.toISOString())
  } },
  { name: 'a reason outside WAKE', set: (db: Db) => db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7") },
])('D3 a plan $name is not woken', async ({ set }) => {
  const { db, home } = seeded()
  set(db, home)
  const fires: string[] = []
  await woke(db, home, stub(ASK_CEO, fires), now, () => undefined)
  expect(fires).toEqual([])
  expect(runs(db)).toEqual([])
  expect(told(db)).toEqual([])
})

test('D4 a running plan past its ceiling goes to a person once', async () => {
  const { db, home } = seeded()
  const fires: string[] = []
  const posted: string[] = []
  for (let i = 0; i < 2; i += 1) await woke(db, home, stub(ASK_CEO, fires), now, (t) => void posted.push(t))
  expect(fires).toEqual([])
  expect(told(db)).toEqual([{ message: 'ask_ceo: plan is running, not stopped' }])
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(maybe(home, 7, 'orchestrator.md')).toBe('step 4 token_ceiling\n\nask_ceo: plan is running, not stopped\n')
})

test('the store takes blocked_on_ceo, refuses an unknown reason',() => {
  const { db } = seeded()
  const insert = (reason: string) => db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why)
    VALUES (7, 4, ?, 'ask_coo', 'x')`).run(reason)
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
})
