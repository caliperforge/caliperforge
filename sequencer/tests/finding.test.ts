import { cpSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fill } from '../../cli/digests.ts'
import type { Provider } from '../../providers/kind.ts'
import { load } from '../../runner/rules.ts'
import { addFinding, addSetting, findings } from '../../store/drift.ts'
import { logged, runAt } from '../../store/events.ts'
import { migrate, open } from '../../store/index.ts'
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

function stub(fires: string[], outcome = 'fixed'): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      fires.push(packet.prompt)
      return Promise.resolve({ text: `---\noutcome: ${outcome}\nwhy: the cause\n---\n`, transcript_path: packet.transcript,
        usage: { input: 10, cache: 0, output: 5 }, seconds: 0, ended: 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

const wire = {} as Wire

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
  const filing = { file: (...call: Parameters<Wire['file']>) => { calls.push(call); return url } } as Wire
  await answer(db, home, stub([], 'retire'), now, filing)
  expect(registry()).toEqual(before)
  expect(calls.map(([repo, title, , labels]) => [repo, title, labels])).toEqual([[SELF, 'Retire registry entry fixer', ['lane:machine', 'P2', 'fix']]])
  expect(calls[0]?.[2]).toContain('\n**Files:** rules/registry/01-fixer.yaml\n')
  expect(findings(db)).toMatchObject([{ outcome: 'retire', why: 'the cause', ref: url }])
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
