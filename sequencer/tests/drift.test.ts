import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { setting } from '../../store/drift.ts'
import type { Db } from '../../store/index.ts'
import { drift, due, Entry, filed } from '../drift.ts'
import { SELF } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')
const NOW = new Date('2026-10-03T10:00:00Z')
const COO = { name: 'coo_lite', switch: { key: 'coo_lite.apply', value: '1' }, table: 'events', column: 'at', where: "kind = 'coo_lite'", gap: '2d' }

function db(enabled = 1): Db {
  const d = fresh(schema)
  d.exec(`UPDATE pipes SET enabled = ${String(enabled)};
    INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT min(id) FROM pipes), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/1', 0, 3);
    INSERT INTO settings (key, value, who, origin_kind, origin_ref, set_at) VALUES ('coo_lite.apply', '1', 'ceo', 'ruling', 'r', '2026-10-01')`)
  return d
}

function event(d: Db, at: string): void {
  d.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (1, ?, 'coo_lite', 'coo_lite', 'pass', 'm')").run(at)
}

test('switchOff', () => {
  const d = db()
  const entries = [COO, { name: 'hq', switch: { key: 'hq.path' } }]
  event(d, '2026-10-03 09:00:00')
  d.exec("UPDATE settings SET value = '0' WHERE key = 'coo_lite.apply'")
  expect(drift(d, entries, NOW).map((r) => [r.name, r.state])).toEqual([['coo_lite', 'off'], ['hq', 'off']])
  d.exec("DELETE FROM settings WHERE key = 'coo_lite.apply'")
  expect(drift(d, entries, NOW)[0]).toEqual({ name: 'coo_lite', state: 'off', detail: 'coo_lite.apply is unset' })
})

test('staleRow', () => {
  const d = db(0)
  expect(drift(d, [COO], NOW)).toEqual([{ name: 'coo_lite', state: 'silent', detail: "no row in events WHERE kind = 'coo_lite'" }])
  event(d, '2026-09-30 10:00:00')
  expect(drift(d, [COO], NOW).map((r) => r.state)).toEqual(['stale'])
  expect(drift(d, [{ ...COO, gap: undefined }], NOW)).toEqual([])
  expect(drift(d, [{ ...COO, while: 'EXISTS (SELECT 1 FROM pipes WHERE enabled = 1)' }], NOW)).toEqual([])
})

test('fresh', () => {
  const d = db()
  event(d, '2026-10-02 10:00:00')
  expect(drift(d, [COO, { ...COO, name: 'six', gap: '24h' }], NOW)).toEqual([])
  const registry = z.array(Entry).parse(parse(readFileSync(join(import.meta.dirname, '../../rules/registry.yaml'), 'utf8')))
  expect(registry.map((e) => e.name)).toEqual(['coo_lite', 'orchestrator', 'fixer', 'brief_writer', 'text_review',
    'growth_lead', 'gardener', 'ratchet', 'accounts', 'records', 'dispositions', 'signoffs', 'proposals',
    'ratchet_refuse', 'hq', 'desk', 'intake'])
  expect(() => drift(d, registry, NOW)).not.toThrow()
  for (const bad of [{ gap: '2 days' }, { table: 'events;' }, { column: 'At' }]) {
    expect(() => Entry.parse({ name: 'x', ...bad })).toThrow()
  }
})

test('fileOnce', () => {
  const d = db()
  const sent: [string, string, string, string[]][] = []
  const wire = { file: (repo: string, title: string, body: string, labels: string[]): string => {
    sent.push([repo, title, body, labels])
    return `u${String(sent.length)}`
  } }
  d.exec(`INSERT INTO tickets (repo, number, title, lane) VALUES ('${SELF}', 1, 'Drift: hq is off', 'machine');
    INSERT INTO tickets (repo, number, title, lane, closed_at) VALUES ('${SELF}', 2, 'Drift: desk is off', 'machine', '2026-10-01')`)
  const rows = [{ name: 'hq', state: 'off', detail: 'd' }, { name: 'desk', state: 'off', detail: 'd' }] as const
  expect(filed(d, [...rows], wire)).toEqual(['u1'])
  expect(sent).toEqual([[SELF, 'Drift: desk is off', '**What:** desk is off: d\n' +
    '**Why:** rules/registry.yaml lists desk as a mechanism that runs\n**When it ends:** drift no longer reports desk\n',
  ['lane:machine', 'P1', 'drift']]])
})

test('dailyOnce', () => {
  const d = db()
  let sent = 0
  const wire = { file: (): string => `u${String(++sent)}` }
  const hq = [{ name: 'hq', switch: { key: 'hq.path' } }]
  expect(due(d, hq, new Date('2026-10-03T11:29:00Z'), wire)).toEqual([])
  expect(due(d, hq, new Date('2026-10-03T11:30:00Z'), wire)).toEqual(['u1'])
  expect(due(d, hq, new Date('2026-10-04T05:00:00Z'), wire)).toEqual([])
  expect(due(d, hq, new Date('2026-10-04T11:30:00Z'), wire)).toEqual(['u2'])
  const e = db()
  expect(() => due(e, hq, new Date('2026-10-03T11:30:00Z'), { file: () => { throw new Error('gh') } })).toThrow('gh')
  expect(setting(e, 'drift.at')).toBe('2026-10-03')
})
