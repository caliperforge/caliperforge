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
