import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Packet, Provider } from '../../providers/kind.ts'
import { migrate, open } from '../../store/index.ts'
import type { Wire } from '../push.ts'
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
  return { db, home }
}

function stub(fix: string, packets: Packet[]): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      packets.push(packet)
      const text = basename(packet.transcript).startsWith('fixer') ? fix : ASK_COO
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
        seconds: 0, exit: 0, stop_reason: 'end_turn', denials: 0 })
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
})

test('a machine bug becomes a top ticket and the job is parked', async () => {
  const { db, home } = seeded('live')
  const filed: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: ticket\nwhy: the spend wall counts a turn four times\nticket: the run wall counts each streamed block\n---\n', []),
    now, () => undefined, wire(filed))
  expect(filed).toEqual(['the run wall counts each streamed block'])
  expect(state(db)).toEqual({ state: 'halted', step: 4 })
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
