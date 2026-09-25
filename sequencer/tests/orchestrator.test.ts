import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import { woke } from '../orchestrator.ts'
import { drop, maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-24T12:00:00.000Z')
const VALID = 'thinking\n\n---\nverb: ask_ceo\nwhy: it spent the ceiling on one refusal\n---\n'

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  const home = mkdtempSync(join(tmpdir(), 'cf-orch-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'step-4.verdict.md', '---\noutcome: refuse\nspans:\n  - runner/wake.ts\n---\n')
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

function state(db: ReturnType<typeof open>, home: string) {
  const src = srcDir(home, 7)
  return {
    plan: db.prepare('SELECT * FROM plans WHERE id = 7').get(),
    files: readdirSync(src, { recursive: true, encoding: 'utf8' }).map((f) => [f, readFileSync(join(src, f), 'utf8')]),
  }
}

const decisions = (db: ReturnType<typeof open>) => db.prepare('SELECT plan, step, wait_reason, verb, why, evidence, tokens FROM decisions').all()

test('D1 a waiting plan gets one decision and is left byte-identical', async () => {
  const { db, home } = seeded()
  const fires: string[] = []
  const before = state(db, home)
  await woke(db, home, stub(VALID, fires), now)
  expect(decisions(db)).toEqual([{ plan: 7, step: 4, wait_reason: 'token_ceiling', verb: 'ask_ceo',
    why: 'it spent the ceiling on one refusal', evidence: null, tokens: 40 }])
  expect(state(db, home)).toEqual(before)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toBe('step 4 token_ceiling')
  await woke(db, home, stub(VALID, fires), now)
  expect(decisions(db)).toHaveLength(1)
  expect(fires).toHaveLength(1)
})

test.each([
  { answer: 'no fence', text: 'retry, it will pass', path: 'fence' },
  { answer: 'an off-menu verb', text: '---\nverb: merge\nwhy: it is green\n---\n', path: 'verb' },
  { answer: 'an extra field', text: '---\nverb: retry\nwhy: it flaked\nconfidence: high\n---\n', path: 'confidence' },
])('D2 $answer is refused and decides nothing', async ({ text, path }) => {
  const { db, home } = seeded()
  const before = state(db, home)
  await woke(db, home, stub(text, []), now)
  expect(decisions(db)).toEqual([])
  expect(state(db, home)).toEqual(before)
  expect(maybe(home, 7, 'orchestrator.md'))
    .toBe(`step 4 token_ceiling\n\norigin_kind: ruling\norigin_ref: orchestrator.decision\npath: ${path}\n`)
})

test('D3 a packet wake() refuses fires no model and records the refusal', async () => {
  const { db, home } = seeded()
  drop(home, 7, 'base.sha')
  const fires: string[] = []
  await woke(db, home, stub(VALID, fires), now)
  expect(fires).toEqual([])
  expect(maybe(home, 7, 'orchestrator.md'))
    .toBe('step 4 token_ceiling\n\norigin_kind: ruling\norigin_ref: orchestrator.packet\npath: base\n')
})

test('D4 a reason outside WAKE is not woken', async () => {
  const { db, home } = seeded()
  db.exec("UPDATE plans SET wait_reason = 'over_cap' WHERE id = 7")
  const fires: string[] = []
  await woke(db, home, stub(VALID, fires), now)
  expect(fires).toEqual([])
  expect(maybe(home, 7, 'orchestrator.md')).toBeNull()
})

const blocked = (db: ReturnType<typeof open>) =>
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")

test('#246 a plan stopped for a person gets one decision per distinct stop, and is left byte-identical', async () => {
  const { db, home } = seeded()
  blocked(db)
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\nthe binding is stale\n')
  const fires: string[] = []
  const before = state(db, home)
  await woke(db, home, stub(VALID, fires), now)
  expect(decisions(db)).toMatchObject([{ plan: 7, step: 4, wait_reason: 'blocked_on_ceo', verb: 'ask_ceo' }])
  expect(state(db, home)).toEqual(before)
  expect(maybe(home, 7, 'orchestrator.md')?.split('\n')[0]).toMatch(/^step 4 blocked [0-9a-f]{12}$/)
  await woke(db, home, stub(VALID, fires), now)
  expect(fires).toHaveLength(1)
  put(home, 7, 'refusal.md', 'step 4 review refused by code_quality\n\na different finding\n')
  await woke(db, home, stub(VALID, fires), now)
  expect(decisions(db)).toHaveLength(2)
})

test('#246 the packet carries the words the plan stopped with', async () => {
  const { db, home } = seeded()
  blocked(db)
  put(home, 7, 'refusal.md', 'the build changed nothing since the last refusal\n')
  const packets: string[] = []
  const provider: Provider = {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      packets.push(JSON.stringify(packet))
      return Promise.resolve({ text: VALID, transcript_path: packet.transcript, usage: { input: 1, cache: 0, output: 1 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
  await woke(db, home, provider, now)
  expect(packets[0]).toContain('# stop')
  expect(packets[0]).toContain('the build changed nothing since the last refusal')
})

test('#246 a blocked plan with a reason on the wake list keeps that reason and is woken once', async () => {
  const { db, home } = seeded()
  db.exec("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = 7")
  const fires: string[] = []
  await woke(db, home, stub(VALID, fires), now)
  await woke(db, home, stub(VALID, fires), now)
  expect(decisions(db)).toMatchObject([{ wait_reason: 'token_ceiling' }])
  expect(fires).toHaveLength(1)
})

test('#246 the store takes blocked_on_ceo as a decision reason and still refuses an unknown one', () => {
  const { db } = seeded()
  const insert = (reason: string) => db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why)
    VALUES (7, 4, ?, 'ask_coo', 'x')`).run(reason)
  expect(() => insert('blocked_on_ceo')).not.toThrow()
  expect(() => insert('made_up')).toThrow(/CHECK/)
})

const RETRY = '---\nverb: retry\nwhy: the reviewer found a defect the builder can fix\n---\n'

function wheel(db: ReturnType<typeof open>) {
  db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at)
    VALUES ('orchestrator.apply', '1', 'ceo', 'ruling', 'ceo-2026-09-25', '2026-09-25')`).run()
}

const applied = (db: ReturnType<typeof open>) =>
  (db.prepare('SELECT verb, applied FROM decisions ORDER BY id').all() as { verb: string; applied: string | null }[])

test('#238 in shadow a decision changes nothing', async () => {
  const { db, home } = seeded()
  blocked(db)
  put(home, 7, 'refusal.md', 'step 4 review refused\n')
  await woke(db, home, stub(RETRY, []), now, () => undefined)
  expect(db.prepare('SELECT state, step FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(applied(db)).toEqual([{ verb: 'retry', applied: null }])
})

test('#238 with the wheel, retry sends the plan back to the builder with its refusals cleared', async () => {
  const { db, home } = seeded()
  blocked(db)
  wheel(db)
  put(home, 7, 'refusal.md', 'step 4 review refused\n')
  await woke(db, home, stub(RETRY, []), now, () => undefined)
  expect(db.prepare('SELECT state, step FROM plans WHERE id = 7').get()).toEqual({ state: 'running', step: 2 })
  expect(db.prepare('SELECT count(*) AS n FROM refusals WHERE plan = 7 AND cleared = 0').get()).toEqual({ n: 0 })
  expect(applied(db)).toEqual([{ verb: 'retry', applied: 'applied' }])
  expect(db.prepare('SELECT count(*) AS n FROM leases').get()).toEqual({ n: 0 })
})

test('#238 a verb off the mechanical list goes to a person and moves nothing', async () => {
  const { db, home } = seeded()
  blocked(db)
  wheel(db)
  put(home, 7, 'refusal.md', 'step 4 review refused\n')
  const posted: string[] = []
  await woke(db, home, stub(VALID, []), now, (title) => void posted.push(title))
  expect(db.prepare('SELECT state, step FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(applied(db)).toEqual([{ verb: 'ask_ceo', applied: 'escalated' }])
  expect(posted).toEqual(['CaliperForge · #139 needs a person'])
})

test('#238 a plan moved twice in a day is capped and handed to a person', async () => {
  const { db, home } = seeded()
  blocked(db)
  wheel(db)
  for (let i = 0; i < 2; i += 1) {
    db.prepare(`INSERT INTO decisions (plan, step, wait_reason, verb, why, applied, at)
      VALUES (7, 4, 'blocked_on_ceo', 'retry', 'x', 'applied', '2026-09-24 20:00:00')`).run()
  }
  put(home, 7, 'refusal.md', 'step 4 review refused again\n')
  const posted: string[] = []
  await woke(db, home, stub(RETRY, []), now, (title) => void posted.push(title))
  expect(db.prepare('SELECT state FROM plans WHERE id = 7').get()).toEqual({ state: 'blocked_on_ceo' })
  expect(applied(db).at(-1)).toEqual({ verb: 'retry', applied: 'capped' })
  expect(posted).toHaveLength(1)
})

test('#238 a stop another live tick holds is left for the next wake', async () => {
  const { db, home } = seeded()
  blocked(db)
  put(home, 7, 'refusal.md', 'step 4 review refused\n')
  db.prepare('INSERT INTO leases (plan, pid, taken_at) VALUES (7, ?, ?)').run(process.ppid, now.toISOString())
  const fires: string[] = []
  await woke(db, home, stub(RETRY, fires), now, () => undefined)
  expect(fires).toEqual([])
  expect(maybe(home, 7, 'orchestrator.md')).toBeNull()
})

test('#238 a colon inside why or evidence is prose, not a broken fence', async () => {
  const { db, home } = seeded()
  blocked(db)
  put(home, 7, 'refusal.md', 'step 3 rails refused\n')
  const text = '```\n---\nverb: ask_coo\nwhy: Same refusal twice: the brief names a test that does not exist.\n' +
    'evidence: identifiers: 1 identifier(s) name no source in the tree\n---\n```'
  await woke(db, home, stub(text, []), now, () => undefined)
  expect(decisions(db)).toMatchObject([{ verb: 'ask_coo', why: 'Same refusal twice: the brief names a test that does not exist.',
    evidence: 'identifiers: 1 identifier(s) name no source in the tree' }])
})
