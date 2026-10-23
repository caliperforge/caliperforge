import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { registered } from '../../runner/rules.ts'
import { addRun } from '../../store/brief.ts'
import { decided } from '../../store/decisions.ts'
import { proofed } from '../../store/desk.ts'
import { addSetting } from '../../store/drift.ts'
import { logged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { briefed, planById, putPlan } from '../../store/plans.ts'
import { drift, Entry, mechanisms } from '../drift.ts'
import { db, NOW, REGISTRY } from './drifting.ts'

const FIXER = REGISTRY.filter((e) => e.name === 'fixer')

function live(): Db {
  const d = db()
  addSetting(d, { key: 'fixer.mode', value: 'live', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-10-01' })
  return d
}

function act(d: Db, at: string, actor = 'fixer'): void {
  logged(d, { plan: 1, kind: 'return', actor, outcome: 'pass', message: 'm', pointer: null, run: null }, at)
}

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  mkdirSync(join(dir, 'rules/registry'), { recursive: true })
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
  return dir
}

test('checkoutMatchesFixture', () => {
  const fixture = readFileSync(join(import.meta.dirname, 'fixtures/registry.yaml'), 'utf8')
  expect(mechanisms(join(import.meta.dirname, '../..'))).toEqual(Entry.array().parse(parse(fixture)))
})

test('checkoutJoinsToFixture', () => {
  const repo = join(import.meta.dirname, '../..')
  const joined = registered(repo).map((path) => readFileSync(join(repo, path), 'utf8')).join('')
  expect(joined).toBe(readFileSync(join(import.meta.dirname, 'fixtures/registry.yaml'), 'utf8'))
})

test('registryFileIgnored', () => {
  const dir = root({
    'rules/registry.yaml': '- name: a\n',
    'rules/registry/01-c.yaml': '- name: c\n',
    'rules/registry/00-b.yaml': '- name: b\n',
    'rules/registry/notes.md': '- name: d\n',
  })
  expect(registered(dir)).toEqual(['rules/registry/00-b.yaml', 'rules/registry/01-c.yaml'])
  expect(mechanisms(dir).map((e) => e.name)).toEqual(['b', 'c'])
})

test('folderAlone', () => {
  expect(registered(root({ 'rules/registry/00-b.yaml': '- name: b\n' }))).toEqual(['rules/registry/00-b.yaml'])
})

test('badEntryThrows', () => {
  expect(() => mechanisms(root({ 'rules/registry/00-b.yaml': '- name: b\n  gap: 2w\n' }))).toThrow()
})

test('fixerEventFresh', () => {
  const d = live()
  act(d, '2026-10-02 10:00:00')
  expect(drift(d, FIXER, NOW)).toEqual([])
})

test('fixerEventStale', () => {
  const d = live()
  act(d, '2026-09-30 10:00:00')
  expect(drift(d, FIXER, NOW)).toEqual([{ name: 'fixer', state: 'stale', detail: 'newest events.at is 2026-09-30 10:00:00, older than 2d',
    newest: '2026-09-30 10:00:00' }])
})

test('otherActorSilent', () => {
  const d = live()
  act(d, '2026-10-02 10:00:00', 'director')
  expect(drift(d, FIXER, NOW)).toEqual([{ name: 'fixer', state: 'silent', detail: "no row in events WHERE actor = 'fixer'" }])
})

test('fixerRunSilent', () => {
  const d = live()
  addRule(d, { id: 'fixer', kind: 'card', path: 'seats/fixer.md', content_hash: 'a'.repeat(64), loaded_at: '2026-10-01' })
  addRun(d,{ plan: 1, step: 2, seat: 'fixer', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
    input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
    at: '2026-10-02 10:00:00', transcript_path: 'x.transcript.jsonl', cost_usd: null })
  expect(drift(d, FIXER, NOW)).toEqual([{ name: 'fixer', state: 'silent', detail: "no row in events WHERE actor = 'fixer'" }])
})

test('designOnMainSeen D5', () => {
  const onMain = REGISTRY.filter((e) => e.name === 'design_on_main')
  const d = db()
  const review = (message: string): void => {
    logged(d, { plan: 1, kind: 'review', actor: 'design', outcome: 'pass', message, pointer: null, run: null }, '2026-10-02 10:00:00')
  }
  review('design pass')
  expect(drift(d, onMain, NOW)).toEqual([])
  review('design pass; already on main: x')
  expect(drift(d, onMain, NOW)).toMatchObject([{ name: 'design_on_main', state: 'seen', newest: '2026-10-02 10:00:00' }])
})

test('directorDesignWaiveSeen D5', () => {
  const entry = REGISTRY.filter((e) => e.name === 'director_design_waive')
  const d = db()
  putPlan(d, { id: 2, pipe_id: planById(d, 1).pipe_id, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-01', step: 4, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/a/b/issues/2' })
  const at = '2026-10-02 10:00:00'
  const log = (plan: number, kind: string, outcome: 'pass' | 'refuse', message: string): void => {
    logged(d, { plan, kind, actor: kind, outcome, message, pointer: null, run: null }, at)
  }
  log(1, 'review', 'refuse', 'design: no screen served')
  expect(drift(d, entry, NOW)).toEqual([])
  log(2, 'director', 'pass', 'waive: x')
  log(1, 'review', 'refuse', 'design: no screen served')
  expect(drift(d, entry, NOW)).toEqual([])
  log(1, 'director', 'pass', 'waive: x')
  log(1, 'review', 'refuse', 'design: no screen served')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'director_design_waive', state: 'seen', newest: at }])
})

test('sitePushSeen D5', () => {
  const sitePush = REGISTRY.filter((e) => e.name === 'site_push')
  const push = (d: Db, outcome: 'pass' | 'refuse', at: string | null): void => {
    logged(d, { plan: null, kind: 'site_push', actor: 'tick', outcome, message: 'm', pointer: null, run: null }, at)
  }
  const d = db()
  push(d, 'refuse', '2026-10-02 10:00:00')
  expect(drift(d, sitePush, NOW)).toMatchObject([{ name: 'site_push', state: 'seen', newest: '2026-10-02 10:00:00' }])
  push(d, 'pass', '2026-10-02 11:00:00')
  expect(drift(d, sitePush, NOW)).toEqual([])
  const now = db()
  push(now, 'refuse', null)
  expect(drift(now, sitePush, new Date())).toEqual([])
})

test('researchQuoteTextSeen D6', () => {
  const entry = REGISTRY.filter((e) => e.name === 'research_quote_text')
  const d = db()
  expect(drift(d, entry, NOW)).toEqual([])
  logged(d, { plan: 1, kind: 'check', actor: 'check', outcome: 'refuse', message: 'quote not on the page for x', pointer: null, run: null }, '2026-10-02 10:00:00')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'research_quote_text', state: 'seen', newest: '2026-10-02 10:00:00' }])
})

test('directorToFixerSeen D7', () => {
  const entry = REGISTRY.filter((e) => e.name === 'director_to_fixer')
  const at = '2026-10-02 10:00:00'
  const told = (d: Db, message = 'rule did not apply, x'): void => {
    logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'needs_coo', message, pointer: null, run: null }, at)
  }
  const meant = db()
  told(meant, 'return: refused by the fence, the plan stopped at its build cap')
  told(meant, 'ask_coo: director answered this plan twice today')
  expect(drift(meant, entry, NOW)).toEqual([])
  const bare = db()
  told(bare)
  expect(drift(bare, entry, NOW)).toMatchObject([{ name: 'director_to_fixer', state: 'seen', newest: at }])
  const handed = db()
  decided(handed, { plan: 1, step: 0, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: 'x', evidence: null, tokens: 0 }, '2026-10-02 09:30:00')
  told(handed)
  expect(drift(handed, entry, NOW)).toEqual([])
})

test('catchupRangeClearsSilent D4', () => {
  const d = db()
  const catchup = REGISTRY.filter((e) => e.name === 'writer_catchup')
  putPlan(d, { id: 2, pipe_id: planById(d, 1).pipe_id, target_id: null, template: 'comms', state: 'queued', queued_at: '2026-10-01', step: 0, retries: 0 })
  briefed(d, 2, { title: 'catchup 2026-09-26 2026-10-02', what: null, why: null, ends: null })
  const post = { kind: 'catchup', dest: 'site', title: 't', dek: 'd', body: 'b', sources: '[]', checks: '[]', written_date: '2026-10-02' } as const
  proofed(d, { ...post, id: 3_000_002, work_date: '2026-09-26' })
  expect(drift(d, catchup, NOW)).toMatchObject([{ name: 'writer_catchup', state: 'silent' }])
  proofed(d, { ...post, id: 4_000_002, work_date: '2026-09-27–2026-10-02' })
  expect(drift(d, catchup, NOW)).toEqual([])
})
