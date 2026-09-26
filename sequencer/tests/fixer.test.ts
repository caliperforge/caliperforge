import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import type { Wire } from '../push.ts'
import { terminal } from '../../store/plans.ts'
import { woke } from '../orchestrator.ts'
import { maybe, put, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-25T17:00:00.000Z')
const ASK_COO = '---\nverb: ask_coo\nwhy: the brief names a migration number another job took\n---\n'

function seeded(mode: string) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  db.prepare(`INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES
    ('orchestrator.apply', '1', 'ceo', 'ruling', 't', '2026-09-25'), ('fixer.mode', ?, 'ceo', 'ruling', 't', '2026-09-25')`).run(mode)
  const home = mkdtempSync(join(tmpdir(), 'cf-fx-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'refusal.md', 'step 3 rails refused\n\nidentifiers: schema/0036_x.sql names no source\n')
  put(home, 7, 'step-4.verdict.md', '---\noutcome: refuse\nspans:\n  - x\n---\n')
  put(home, 7, 'base.sha', `${'a'.repeat(40)}\n`)
  writeFileSync(join(srcDir(home, 7), 'index.ts'), 'export {}\n')
  mkdirSync(join(srcDir(home, 7), '.git'))
  return { db, home }
}

function stub(fix: string, packets: Packet[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      packets.push(packet)
      const text = basename(packet.transcript).startsWith('fixer') ? fix : ASK_COO
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
        seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

function wire(filed: string[]): Wire {
  const no = (): never => { throw new Error('not in this test') }
  return { send: no, open: no, close: no, runs: no, comment: no,
    file: (...args) => { const title = args[1]; filed.push(title); return 'https://github.com/caliperforge/caliperforge/issues/999' } }
}

const state = (db: ReturnType<typeof open>) => db.prepare('SELECT state, step FROM plans WHERE id = 7').get()
const applied = (db: ReturnType<typeof open>) => db.prepare('SELECT applied FROM decisions').all()
const runs = (db: ReturnType<typeof open>) => db.prepare(`SELECT seat, input_tokens, cache_tokens, output_tokens,
  transcript_path LIKE '%/run-' || id || '.transcript.jsonl' AS named FROM runs
  WHERE plan = 7 AND seat IN ('fixer', 'orchestrator') ORDER BY id`).all()
const RAN = [{ seat: 'orchestrator', input_tokens: 10, cache_tokens: 0, output_tokens: 5, named: 1 },
  { seat: 'fixer', input_tokens: 10, cache_tokens: 0, output_tokens: 5, named: 1 }]

const RETURN = '---\ndid: renamed schema/0036_x.sql to 0040_x.sql in src and issue.md\nthen: return\nwhy: the rails will find the file now\nadd_files: [schema/0040_x.sql]\n---\n'

test('live: an ask_coo stop goes to the fixer, which fixes it and returns the job; nobody is pinged', async () => {
  const { db, home } = seeded('live')
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(applied(db)).toEqual([{ applied: 'applied' }])
  expect(posted).toEqual([])
  expect(db.prepare("SELECT path FROM plan_files WHERE plan = 7").all()).toEqual([{ path: 'schema/0040_x.sql' }])
  const fixerPacket = packets.find((p) => basename(p.transcript).startsWith('fixer'))
  expect(fixerPacket?.tools).toContain('Edit')
  expect(fixerPacket?.prompt).toContain('# The machine\'s store')
  expect(runs(db)).toEqual(RAN)
})

test('shadow: the fixer reads only, changes nothing, and the stop still reaches a person', async () => {
  const { db, home } = seeded('shadow')
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(posted).toHaveLength(1)
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"mode":"shadow"')
  expect(runs(db)).toEqual(RAN)
})

test('ticket: filed, job held, checkout kept', async () => {
  const { db, home } = seeded('live')
  const filed: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: ticket\nwhy: the spend wall counts a turn four times\nticket: the run wall counts each streamed block\n---\n', []),
    now, () => undefined, wire(filed))
  expect(filed).toEqual(['the run wall counts each streamed block'])
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(maybe(home, 7, 'parked.md')).toContain('issues/999')
  expect(terminal(db)).not.toContain(7)
})

test('ask_ceo from the fixer reaches the phone with its reason', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: ask_ceo\nwhy: this changes what surfpool\'s maintainer sees\n---\n', []),
    now, (t) => void posted.push(t), wire([]))
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(applied(db)).toEqual([{ applied: 'escalated' }])
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
})

test('after two live fixes in a day the fixer is not called and the stop escalates as before', async () => {
  const { db, home } = seeded('live')
  const at = new Date(now.getTime() - 60_000).toISOString()
  const line = JSON.stringify({ at, mode: 'live', did: 'x', then: 'return', why: 'y', tokens: 1, applied: 'return' })
  put(home, 7, 'fixes.jsonl', `${line}\n${line}\n`)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(false)
  expect(posted).toHaveLength(1)
})

test('a file the build already wrote as a stray is listed by clearing the flag, not by a second row', async () => {
  const { db, home } = seeded('live')
  db.prepare("INSERT INTO plan_files (plan, path, is_new, position, stray) VALUES (7, 'a.ts', 0, 0, 0), (7, 'schema/0040_x.sql', 1, 1, 1)").run()
  await woke(db, home, stub(RETURN, []), now, () => undefined, wire([]))
  expect(db.prepare('SELECT path, position, stray FROM plan_files WHERE plan = 7 ORDER BY position').all()).toEqual([
    { path: 'a.ts', position: 0, stray: 0 }, { path: 'schema/0040_x.sql', position: 1, stray: 0 }])
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
})

test('a fixer that throws leaves the tick running and the stop with a person', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  const broken: Wire = { ...wire([]), file: () => { throw new Error('gh is down') } }
  await woke(db, home, stub('---\ndid: nothing\nthen: ticket\nwhy: a bug\nticket: a bug\n---\n', []), now, (t) => void posted.push(t), broken)
  expect(maybe(home, 7, 'fixer.error')).toBe('gh is down')
  expect(posted).toHaveLength(1)
})

const WAIT = '---\ndid: answered in ask.md that it builds on plan 8\nthen: wait\nwhy: plan 8 has not landed\nwaits_on: 8\n---\n'

function second(db: ReturnType<typeof open>, state = 'running') {
  db.prepare(`INSERT INTO plans (id, pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (8, 9, 'pr_path', ?, '2026-09-24', 2, 0, 1, 'machine', 'typescript_specialist',
    'https://github.com/caliperforge/caliperforge/issues/140')`).run(state)
}

const waitsOn = (db: ReturnType<typeof open>) => db.prepare('SELECT waits_on FROM plans WHERE id = 7').get()

test('gone checkout: rebuilt, no model', async () => {
  const { db, home } = seeded('live')
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  put(home, 7, 'base.merged', `${'b'.repeat(40)}\n`)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 2 })
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(false)
  expect(posted).toEqual([])
  expect(maybe(home, 7, 'refusal.prev.md')).toContain('rails refused')
  expect(maybe(home, 7, 'refusal.md')).toBeNull()
  expect(maybe(home, 7, 'base.merged')).toBeNull()
  expect(maybe(home, 7, 'base.sha')).not.toBeNull()
  expect(db.prepare('SELECT cleared FROM refusals WHERE plan = 7').all()).toEqual([{ cleared: 1 }])
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"rebuild"')
})

test('gone checkout, shadow: untouched', async () => {
  const { db, home } = seeded('shadow')
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  const posted: string[] = []
  await woke(db, home, stub(RETURN, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(posted).toHaveLength(1)
})

test('rebuild with a live checkout escalates', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: rebuild\nwhy: x\n---\n', []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(existsSync(join(home, '.cf/work/7/src/index.ts'))).toBe(true)
  expect(posted).toHaveLength(1)
})

test('wait: held quietly, released on land', async () => {
  const { db, home } = seeded('live')
  second(db)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(WAIT, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: 8 })
  expect(posted).toEqual([])
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.prompt).toContain('- plan 8, running, step 2')
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  db.exec("UPDATE plans SET state = 'done' WHERE id = 8")
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(posted).toEqual([])
})

test('wait on a refused job pings', async () => {
  const { db, home } = seeded('live')
  second(db)
  const posted: string[] = []
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  db.exec("UPDATE plans SET state = 'refused' WHERE id = 8")
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
})

test('wait on a closed job escalates', async () => {
  const { db, home } = seeded('live')
  second(db, 'done')
  const posted: string[] = []
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(posted).toHaveLength(1)
})

test('gone checkout, outside plan: to a person', async () => {
  const { db, home } = seeded('live')
  db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706')`)
  db.exec("UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7")
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  const packets: Packet[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: rebuild\nwhy: x\n---\n', packets), now, () => undefined, wire([]))
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(true)
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
})

test('park: held, not reaped, not re-woken', async () => {
  const { db, home } = seeded('live')
  const packets: Packet[] = []
  const PARK = '---\ndid: nothing\nthen: park\nwhy: builds on a job not yet filed\n---\n'
  await woke(db, home, stub(PARK, packets), now, () => undefined, wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(terminal(db)).not.toContain(7)
  rmSync(join(home, '.cf/work/7/orchestrator.md'))
  await woke(db, home, stub(PARK, packets), now, () => undefined, wire([]))
  expect(packets.filter((p) => basename(p.transcript).startsWith('orchestrator'))).toHaveLength(1)
})

test('a # in did or why is kept whole', async () => {
  const { db, home } = seeded('live')
  const fix = '---\ndid: nothing; #37 landed at 22775be\nthen: ask_ceo\nwhy: #261: split of a split\n---\n'
  await woke(db, home, stub(fix, []), now, () => undefined, wire([]))
  const line = JSON.parse((maybe(home, 7, 'fixes.jsonl') ?? '').trim()) as { did: string; why: string }
  expect(line.did).toBe('nothing; #37 landed at 22775be')
  expect(line.why).toBe('#261: split of a split')
})
