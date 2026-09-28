import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import { coo } from '../coo.ts'
import { put } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  const like = db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    SELECT @id, pipe_id, template, @state, queued_at, step, retries, priority, lane, seat,
      'https://github.com/caliperforge/caliperforge/issues/' || (800 + @id) FROM plans WHERE id = 7`)
  like.run({ id: 5, state: 'done' })
  like.run({ id: 8, state: 'blocked_on_ceo' })
  like.run({ id: 9, state: 'done' })
  const parts = db.prepare("INSERT INTO parts (parent, n, url, title, body, plan) VALUES (5, ?, ?, 'part', 'body', ?)")
  parts.run(0, 'https://github.com/caliperforge/caliperforge/issues/901', 7)
  parts.run(1, 'https://github.com/caliperforge/caliperforge/issues/902', 9)
  for (const plan of [7, 8]) decide(db, plan, 'escalated')
  db.exec(`INSERT INTO rulings (subject, value, origin_kind, origin_ref, who, date, issue_no)
    VALUES ('coo.test', 'kept', 'ruling', 't', 'ceo', '2026-09-28', 524)`)
  const home = mkdtempSync(join(tmpdir(), 'cf-coo-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'refusal.md', 'step 3 rails refused seven\n')
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 8, 'question.md', 'which port does eight take\n')
  put(home, 9, 'ask.md', 'the sibling ask\n\n## Ruling\n\nuse bye()\n\n## Answer from the COO\n\nnot this\n')
  return { db, home }
}

function decide(db: ReturnType<typeof open>, plan: number, applied: string): void {
  db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, applied)
    VALUES (?, 4, 'blocked_on_ceo', 'ask_coo', 'held', ?)`).run(plan, applied)
}

function stub(text: string, packets: Packet[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      packets.push(packet)
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

const fence = (entries: string): string => `my calls\n\n---\nrulings:\n${entries}---\n`
const RETURN_7 = '  - plan: 7\n    move: return\n    ruling: rename it: #37 landed\n'
const ASK_8 = '  - plan: 8\n    move: ask_ceo\n    ruling: spend\n    ceo_question: may it take port 80?\n'

test('D1: one fire carries both stops, the sibling ruling and the rulings table, from the root', async () => {
  const { db, home } = seeded()
  const packets: Packet[] = []
  await coo(db, home, stub('', packets))
  expect(packets).toHaveLength(1)
  const [p] = packets
  expect(p?.cwd).toBe(home)
  expect(p?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(p?.prompt).toContain('step 3 rails refused seven')
  expect(p?.prompt).toContain('which port does eight take')
  expect(p?.prompt).toContain('use bye()')
  expect(p?.prompt).not.toContain('not this')
  expect(p?.prompt).toContain('coo.test: kept (ceo 2026-09-28, #524)')
})

test('D2: only the last two fixes reach the packet', async () => {
  const { db, home } = seeded()
  put(home, 7, 'fixes.jsonl', '{"n":"fix-first"}\n{"n":"fix-second"}\n{"n":"fix-third"}\n')
  const packets: Packet[] = []
  await coo(db, home, stub('', packets))
  expect(packets[0]?.prompt).toContain('{"n":"fix-second"}\n{"n":"fix-third"}')
  expect(packets[0]?.prompt).not.toContain('fix-first')
})

test('D3: a stop whose last decision was applied is not gathered, and none gathered fires nothing', async () => {
  const { db, home } = seeded()
  decide(db, 8, 'applied')
  const packets: Packet[] = []
  await coo(db, home, stub('', packets))
  expect(packets[0]?.prompt).toContain('# Plan 7')
  expect(packets[0]?.prompt).not.toContain('# Plan 8')
  decide(db, 7, 'applied')
  expect(await coo(db, home, stub('', packets))).toBeNull()
  expect(packets).toHaveLength(1)
})

test('D4: a return and an ask_ceo entry parse into two entries', async () => {
  const { db, home } = seeded()
  const got = await coo(db, home, stub(fence(RETURN_7 + ASK_8), []))
  expect(got?.entries).toEqual([
    { plan: 7, move: 'return', ruling: 'rename it: #37 landed' },
    { plan: 8, move: 'ask_ceo', ruling: 'spend', ceo_question: 'may it take port 80?' },
  ])
})

test.each([
  { what: 'an ask_ceo with no ceo_question', entries: '  - plan: 8\n    move: ask_ceo\n    ruling: spend\n' },
  { what: 'a return with a ceo_question', entries: '  - plan: 7\n    move: return\n    ruling: x\n    ceo_question: why?\n' },
  { what: 'a ruling over 1,200 characters', entries: `  - plan: 7\n    move: retry\n    ruling: ${'x'.repeat(1201)}\n` },
])('D5: $what refuses the fence', async ({ entries }) => {
  const { db, home } = seeded()
  const got = await coo(db, home, stub(fence(entries), []))
  expect(got?.entries).toBeNull()
})

test('D5: an entry naming a plan outside the packet is dropped', async () => {
  const { db, home } = seeded()
  const got = await coo(db, home, stub(fence(`${RETURN_7}  - plan: 99\n    move: retry\n    ruling: x\n`), []))
  expect(got?.entries).toEqual([{ plan: 7, move: 'return', ruling: 'rename it: #37 landed' }])
})

function files(home: string): Record<string, string> {
  const dir = join(home, '.cf/work')
  return Object.fromEntries(readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
}

test('D6: reads names the site once set, and no plan row or file changes', async () => {
  const { db, home } = seeded()
  const packets: Packet[] = []
  const plans = db.prepare('SELECT * FROM plans ORDER BY id').all()
  const before = files(home)
  await coo(db, home, stub(fence(RETURN_7 + ASK_8), packets))
  expect(packets[0]?.reads).toEqual([])
  expect(db.prepare('SELECT * FROM plans ORDER BY id').all()).toEqual(plans)
  expect(files(home)).toEqual(before)
  db.exec("UPDATE settings SET value = '/srv/site' WHERE key = 'comms.site_dir'")
  await coo(db, home, stub('', packets))
  expect(packets[1]?.reads).toEqual(['/srv/site'])
})
