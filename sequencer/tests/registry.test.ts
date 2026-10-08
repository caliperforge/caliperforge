import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { registered } from '../../runner/rules.ts'
import { addRun } from '../../store/brief.ts'
import { addSetting } from '../../store/drift.ts'
import { logged } from '../../store/events.ts'
import { addRule, type Db } from '../../store/index.ts'
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
  expect(drift(d, FIXER, NOW)).toEqual([{ name: 'fixer', state: 'stale', detail: 'newest events.at is 2026-09-30 10:00:00, older than 2d' }])
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
