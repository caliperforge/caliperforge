import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import type { Pr } from '../../cli/gh.ts'
import { decide } from '../../store/approvals.ts'
import { setting } from '../../store/drift.ts'
import type { Db } from '../../store/index.ts'
import { ratchetRules } from '../../store/lanes.ts'
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
  const entries = [COO, { name: 'desk', switch: { key: 'comms.site_dir' } }]
  event(d, '2026-10-03 09:00:00')
  d.exec("UPDATE settings SET value = '0' WHERE key = 'coo_lite.apply'")
  expect(drift(d, entries, NOW).map((r) => [r.name, r.state])).toEqual([['coo_lite', 'off'], ['desk', 'off']])
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
    'ratchet_refuse', 'intake'])
  expect(ratchetRules(d).mode).toBe('refuse')
  expect(drift(d, registry, NOW).map((r) => r.name)).not.toContain('ratchet_refuse')
  for (const bad of [{ gap: '2 days' }, { table: 'events;' }, { column: 'At' }]) {
    expect(() => Entry.parse({ name: 'x', ...bad })).toThrow()
  }
})

test('proposals', () => {
  const d = db()
  const registry = z.array(Entry).parse(parse(readFileSync(join(import.meta.dirname, '../../rules/registry.yaml'), 'utf8')))
  const proposals = registry.filter((e) => e.name === 'proposals')
  expect(drift(d, proposals, NOW)).toEqual([{ name: 'proposals', state: 'silent', detail: "no row in approvals WHERE subject_kind = 'proposal'" }])
  decide(d, 'proposal', 1, 'a'.repeat(64), 'no')
  expect(drift(d, proposals, NOW)).toEqual([])
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
  const desk = [{ name: 'desk', switch: { key: 'comms.site_dir' } }]
  expect(due(d, desk, new Date('2026-10-03T11:29:00Z'), wire, unread)).toEqual([])
  expect(due(d, desk, new Date('2026-10-03T11:30:00Z'), wire, unread)).toEqual(['u1'])
  expect(due(d, desk, new Date('2026-10-04T05:00:00Z'), wire, unread)).toEqual([])
  expect(due(d, desk, new Date('2026-10-04T11:30:00Z'), wire, unread)).toEqual(['u2'])
  const e = db()
  expect(() => due(e, desk, new Date('2026-10-03T11:30:00Z'), { file: () => { throw new Error('gh') } }, unread)).toThrow('gh')
  expect(setting(e, 'drift.at')).toBe('2026-10-03')
})

const RECORDS = [{ name: 'records', table: 'records', column: 'read_at', gap: '1d' }]
const PR = 'https://github.com/acme/widget/pull/7'
const unread = (): Pr => { throw new Error('read') }
const nothing = { file: (): string => { throw new Error('filed') } }

function ours(d: Db): Db {
  d.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', '2026-09-01', 1, 1, '2026-08-01', 0, 0, 'cold', 'https://github.com/acme/widget/pulse');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 7, 'maintainer', 'queued', '2026-09-01', '${PR}');
    UPDATE plans SET target_id = 1`)
  return d
}

function reader(asked: string[]): (repo: string, no: number) => Pr {
  return (repo, no) => {
    asked.push(`${repo}#${String(no)}`)
    return { number: no, url: PR, state: 'OPEN', mergedAt: null, mergedBy: null, reviewDecision: null, comments: [],
      reviews: [], author: { login: 'caliperforge' }, statusCheckRollup: null }
  }
}

test('D1: the daily check reads our PRs into records first', () => {
  const d = ours(db())
  const asked: string[] = []
  expect(due(d, RECORDS, new Date('2026-10-03T11:30:00Z'), nothing, reader(asked))).toEqual([])
  expect(asked).toEqual(['acme/widget#7'])
  expect(d.prepare('SELECT repo, pr, plan FROM records').all()).toEqual([{ repo: 'acme/widget', pr: 7, plan: 1 }])
})

test('D2: before 05:30 or again that day, nothing is read or filed', () => {
  const d = ours(db())
  expect(due(d, RECORDS, new Date('2026-10-03T11:29:00Z'), nothing, unread)).toEqual([])
  d.exec("UPDATE settings SET value = '2026-10-03' WHERE key = 'drift.at'")
  expect(due(d, RECORDS, new Date('2026-10-03T12:00:00Z'), nothing, unread)).toEqual([])
})

test('D3: a failed read throws, drift.at set, no retry that day', () => {
  const d = ours(db())
  expect(() => due(d, RECORDS, new Date('2026-10-03T11:30:00Z'), nothing, unread)).toThrow('read')
  expect(setting(d, 'drift.at')).toBe('2026-10-03')
  const asked: string[] = []
  expect(due(d, RECORDS, new Date('2026-10-03T12:00:00Z'), nothing, reader(asked))).toEqual([])
  expect(asked).toEqual([])
})
