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
import { logged, runAt } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
import { briefed, planById, putPlan } from '../../store/plans.ts'
import { addReview, type Verdict } from '../../store/verdict.ts'
import { drift, Entry, mechanisms } from '../drift.ts'
import { git } from '../workspace.ts'
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
  expect(REGISTRY).toEqual(Entry.array().parse(parse(fixture)))
})

test('D4 a line carries its seed day as added', () => {
  const dir = root({ 'rules/registry/00-b.yaml': '- name: b\n' })
  for (const args of [['init'], ['config', 'user.name', 'cf'], ['config', 'user.email', 'cf@example.com'], ['config', 'commit.gpgsign', 'false'],
    ['add', '.'], ['commit', '-m', 'bare']]) git(dir, args)
  expect(mechanisms(dir)).toStrictEqual([{ name: 'b', added: undefined }])
  expect(mechanisms(dir, 'HEAD')).toStrictEqual([{ name: 'b', added: undefined }])
  writeFileSync(join(dir, 'rules.seed.sql'), "  ('rules/registry/00-b.yaml', 'card', 'rules/registry/00-b.yaml', 'h', '2026-10-23'),\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'seed'])
  expect(mechanisms(dir)).toEqual([{ name: 'b', added: '2026-10-23' }])
  expect(mechanisms(dir, 'HEAD')).toEqual([{ name: 'b', added: '2026-10-23' }])
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

test('baseRecutSeen D4', () => {
  const entry = REGISTRY.filter((e) => e.name === 'base_recut')
  const d = db()
  expect(drift(d, entry, NOW)).toEqual([])
  logged(d, { plan: 1, kind: 'base_recut', actor: 'workspace', outcome: 'pass', message: 'm', pointer: null, run: null }, '2026-10-02 10:00:00')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'base_recut', state: 'seen', newest: '2026-10-02 10:00:00' }])
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

test('waiveResumesStop D1-D3', () => {
  const entry = REGISTRY.filter((e) => e.name === 'waive_resumes_stop')
  const pass: Verdict = { outcome: 'pass', subject_digest: 'a'.repeat(64), spans: [], origin_kind: null, origin_ref: null, message: 'm', defect_class: null }
  const waived = (reviewed: string, senior = 'b'): Db => {
    const d = db()
    addRule(d, { id: 'typescript_specialist', kind: 'card', path: 'rules/roster.yaml', content_hash: '0'.repeat(64), loaded_at: '2026-09-22' })
    for (const [step, gate, kind, tree] of [[4, 'review', 'review', 'b'], [5, 'senior_review', 'senior', senior]] as const) {
      const id = addReview(d, gate, step, 1, pass, 0, 0, tree.repeat(40))
      logged(d, { plan: 1, kind, actor: kind, outcome: 'pass', message: 'm', pointer: `verdicts:${String(id)}`, run: null }, reviewed)
    }
    logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'pass', message: 'waive: x', pointer: null, run: null }, '2026-10-02 10:00:00')
    runAt(d, 1, 2, 'typescript_specialist', '2026-10-02 11:00:00')
    return d
  }
  expect(drift(waived('2026-10-02 09:00:00'), entry, NOW)).toMatchObject([{ name: 'waive_resumes_stop', state: 'seen', newest: '2026-10-02 10:00:00' }])
  expect(drift(waived('2026-10-02 12:00:00'), entry, NOW)).toEqual([])
  expect(drift(waived('2026-10-02 09:00:00', 'c'), entry, NOW)).toEqual([])
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

test('sitePushSeen D4: a needs_coo push is seen', () => {
  const d = db()
  logged(d, { plan: null, kind: 'site_push', actor: 'tick', outcome: 'needs_coo', message: 'm', pointer: null, run: null }, '2026-10-02 10:00:00')
  expect(drift(d, REGISTRY.filter((e) => e.name === 'site_push'), NOW)).toMatchObject([{ name: 'site_push', state: 'seen' }])
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

test('directorCloseUnbuiltSeen D4', () => {
  const entry = REGISTRY.filter((e) => e.name === 'director_close_unbuilt')
  const d = db()
  d.exec("UPDATE plans SET origin = 'https://github.com/caliperforge/caliperforge/issues/1' WHERE id = 1")
  putPlan(d, { id: 2, pipe_id: planById(d, 1).pipe_id, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-01', step: 4, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/acme/kit/issues/706' })
  const log = (plan: number, kind: string, outcome: 'needs_coo' | 'refuse', message: string, at: string): void => {
    logged(d, { plan, kind, actor: 'director', outcome, message, pointer: null, run: null }, at)
  }
  log(1, 'director', 'needs_coo', 'close did not apply, x', '2026-10-02 09:00:00')
  expect(drift(d, entry, NOW)).toEqual([])
  log(1, 'close', 'refuse', 'the work is on main', '2026-10-02 10:00:00')
  log(2, 'director', 'needs_coo', 'close did not apply, x', '2026-10-02 11:00:00')
  expect(drift(d, entry, NOW)).toEqual([])
  log(1, 'director', 'needs_coo', 'close did not apply, x', '2026-10-02 12:00:00')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'director_close_unbuilt', state: 'seen', newest: '2026-10-02 12:00:00' }])
})

test('forkReadyCiStale D5', () => {
  const entry = REGISTRY.filter((e) => e.name === 'fork_ready_ci')
  const d = db()
  const ready = (message: string, at: string): void => {
    logged(d, { plan: 1, kind: 'ready', actor: 'ready', outcome: 'pass', message, pointer: null, run: null }, at)
  }
  const fork = "ready: ok; caliperforge/pay ran no workflow at abc in 10 ticks; step 3's checks at abc stand as its CI"
  ready(fork, '2026-09-13 10:00:00')
  ready('ready: ok', '2026-10-02 10:00:00')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'fork_ready_ci', state: 'stale', newest: '2026-09-13 10:00:00' }])
  ready(fork, '2026-10-02 10:00:00')
  expect(drift(d, entry, NOW)).toEqual([])
})

test('waiveResumesStopStale D2 D3 D4', () => {
  const entry = REGISTRY.filter((e) => e.name === 'waive_resumes_stop')
  const waived = (at: string, built: string | null): Db => {
    const d = db()
    logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'pass', message: 'waive: x', pointer: null, run: null }, at)
    if (built === null) return d
    addRule(d, { id: 'typescript_specialist', kind: 'card', path: 'seats/typescript_specialist.md', content_hash: 'a'.repeat(64), loaded_at: '2026-09-01' })
    addRun(d, { plan: 1, step: 2, seat: 'typescript_specialist', rule_hash: 'a'.repeat(64), provider: 'claude-agent-sdk', model: 'opus', effort: 'high',
      input_tokens: 0, cache_write_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 0, seconds: 1, exit: 0,
      at: built, transcript_path: 'x.transcript.jsonl', cost_usd: null })
    const pass: Verdict = { outcome: 'pass', subject_digest: 'b'.repeat(64), spans: [], origin_kind: null, origin_ref: null, message: 'm', defect_class: null }
    for (const step of [4, 5]) addReview(d, 'review', step, 1, pass, 0, 1, 'c'.repeat(40))
    return d
  }
  expect(drift(waived('2026-10-02 10:00:00', '2026-10-02 10:30:00'), entry, NOW)).toEqual([])
  expect(drift(waived('2026-09-20 10:00:00', '2026-09-20 10:30:00'), entry, NOW))
    .toMatchObject([{ name: 'waive_resumes_stop', state: 'stale', newest: '2026-09-20 10:00:00' }])
  expect(drift(waived('2026-10-02 10:00:00', null), entry, NOW)).toMatchObject([{ name: 'waive_resumes_stop', state: 'silent' }])
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
