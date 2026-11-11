import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fill } from '../../cli/digests.ts'
import type { Provider } from '../../providers/kind.ts'
import { load } from '../../runner/rules.ts'
import { addFinding, addSetting, findings } from '../../store/drift.ts'
import { logged, ofKind, pointers, runAt } from '../../store/events.ts'
import { type Db, migrate, open } from '../../store/index.ts'
import { drift } from '../drift.ts'
import { answer } from '../finding.ts'
import type { Wire } from '../push.ts'
import { SELF } from '../workspace.ts'
import { db as drifting, NOW, REGISTRY } from './drifting.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-27T09:00:00.000Z')
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)

function seeded() {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  addSetting(db, { key: 'director.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-27' })
  const home = mkdtempSync(join(tmpdir(), 'cf-finding-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  cpSync(join(repo, 'rules.seed.sql'), join(home, 'rules.seed.sql'))
  fill(home, '2026-09-27')
  load(db, home)
  addFinding(db, { name: 'fixer', state: 'off', detail: 'fixer.mode is not live' }, now)
  return { db, home }
}

function stub(fires: string[], outcome = 'fixed', extra = ''): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      fires.push(packet.prompt)
      return Promise.resolve({ text: `---\noutcome: ${outcome}\nwhy: the cause\n${extra}---\n`, transcript_path: packet.transcript,
        usage: { input: 10, cache: 0, output: 5 }, seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

const wire = {} as Wire

const OPEN = `https://github.com/${SELF}/issues/2027`
const POWERED = 'title: `powered()` applies the 8-agent floor to lean generators\nfiles: templates/powered.ts\nends: a lean generator keeps its agents\n'

interface Listed { number: number; title: string; body: string; url: string; comments?: { body: string }[] }
interface Seen { filed: string[]; amended: string[] }

function wired(s: Seen, opened: Listed[] = [], closed: Listed[] = []): Wire {
  const no = (): never => { throw new Error('not in this test') }
  return { send: no, open: no, close: no, runs: no, comment: no, review: no,
    merged: (args) => args.includes('closed') ? closed : opened,
    amend: (...[, n, line]) => void s.amended.push(`#${String(n)} ${line}`),
    file: (...[, title]) => { s.filed.push(title); return `https://github.com/${SELF}/issues/901` } }
}

const compared = (db: Db) => ofKind(db, 'covered').map(({ plan, actor, outcome, message }) => ({ plan, actor, outcome, message }))

test('D1: twelve plan runs today still answer a finding', async () => {
  const { db, home } = seeded()
  for (let i = 0; i < 12; i++) runAt(db, 7, 4, 'director', ago(60 + i))
  const fires: string[] = []
  await answer(db, home, stub(fires), now, wire)
  expect(fires).toHaveLength(1)
  expect(findings(db)).toMatchObject([{ outcome: 'fixed', closed_at: now.toISOString() }])
})

test('D2: three finding runs today fire nothing', async () => {
  const { db, home } = seeded()
  for (const id of [7, 8, 9]) {
    logged(db, { plan: null, kind: 'director', actor: 'director', outcome: 'pass', message: 'fixed: x', pointer: `finding ${String(id)}`, run: null },
      ago(60))
  }
  const fires: string[] = []
  expect(await answer(db, home, stub(fires), now, wire)).toBe('cap reached: 3 finding runs today')
  expect(fires).toEqual([])
  expect(findings(db)).toMatchObject([{ closed_at: null }])
})

test('retire files a ticket and leaves the registry', async () => {
  const { db, home } = seeded()
  const dir = join(home, 'rules/registry')
  const registry = () => readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')])
  const before = registry()
  const url = 'https://github.com/caliperforge/caliperforge/issues/900'
  const calls: Parameters<Wire['file']>[] = []
  const filing: Wire = { ...wired({ filed: [], amended: [] }), file: (...call) => { calls.push(call); return url } }
  await answer(db, home, stub([], 'retire'), now, filing)
  expect(registry()).toEqual(before)
  expect(calls.map(([repo, title, , labels]) => [repo, title, labels])).toEqual([[SELF, 'Retire registry entry fixer', ['lane:machine', 'P2', 'fix']]])
  expect(calls[0]?.[2]).toContain('\n**Files:** rules/registry/01-fixer.yaml\n')
  expect(calls[0]?.[2]).toContain('\nReplaces: registry entry fixer in rules/registry/01-fixer.yaml\n')
  expect(findings(db)).toMatchObject([{ outcome: 'retire', why: 'the cause', ref: url }])
  expect(compared(db)).toMatchObject([{ plan: null, actor: 'finding', outcome: 'pass' }])
})

test('an open ticket naming `powered()` covers the finding', async () => {
  const { db, home } = seeded()
  const s: Seen = { filed: [], amended: [] }
  const listed = [{ number: 2027, title: 'powered() applies the 8-agent floor', body: '', url: OPEN }]
  expect(await answer(db, home, stub([], 'defect', POWERED), now, wired(s, listed))).toBe('covered: the cause')
  expect(s.filed).toEqual([])
  expect(s.amended).toEqual(['#2027 - Also hit by drift finding 1: the cause'])
  expect(findings(db)).toMatchObject([{ outcome: 'covered', why: 'the cause', ref: OPEN, closed_at: now.toISOString() }])
  expect(compared(db)).toEqual([{ plan: null, actor: 'finding', outcome: 'pass',
    message: expect.stringMatching(/^compared "`powered\(\)` applies .* with 1 open, 0 landed, \d+ registry lines: covered by #2027$/) as string }])
  expect(pointers(db, 'covered')).toEqual([OPEN])
})

test('a landed ticket covers the finding with its commit', async () => {
  const { db, home } = seeded()
  const s: Seen = { filed: [], amended: [] }
  const closed = [{ number: 2027, title: 'powered() applies the 8-agent floor', body: '', url: OPEN,
    comments: [{ body: 'landed on main as 4cb0e875' }] }]
  await answer(db, home, stub([], 'defect', POWERED), now, wired(s, [], closed))
  expect(s.filed).toEqual([])
  expect(findings(db)).toMatchObject([{ outcome: 'covered', ref: '4cb0e875', closed_at: now.toISOString() }])
  expect(compared(db)).toMatchObject([{ outcome: 'pass', message: expect.stringMatching(/: landed as 4cb0e875$/) as string }])
})

test('a defect naming a registry line with no Replaces: stays open', async () => {
  const { db, home } = seeded()
  const s: Seen = { filed: [], amended: [] }
  const reply = 'title: research answers skip the ruling\nfiles: sequencer/research.ts\nends: research_question_ruled fires\n'
  await answer(db, home, stub([], 'defect', reply), now, wired(s))
  expect(s.filed).toEqual([])
  expect(findings(db)).toMatchObject([{ outcome: null, closed_at: null }])
  expect(ofKind(db, 'director')).toMatchObject([{ outcome: 'needs_coo',
    message: 'finding 1: not filed: names registry line research_question_ruled with no Replaces: line' }])
  expect(compared(db)).toMatchObject([{ plan: null, actor: 'finding', outcome: 'refuse' }])
})

test('D4: an unanswered finding two days old is silent', () => {
  const entry = REGISTRY.filter((e) => e.name === 'director_findings')
  const d = drifting()
  addFinding(d, { name: 'fixer', state: 'off', detail: 'x' }, new Date(NOW.getTime() - 2 * 86_400_000))
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'director_findings', state: 'silent' }])
  const young = drifting()
  addFinding(young, { name: 'fixer', state: 'off', detail: 'x' }, new Date(NOW.getTime() - 12 * 3_600_000))
  expect(drift(young, entry, NOW)).toEqual([])
})
