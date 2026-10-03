import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { take } from '../../store/leases.ts'
import { drift, due, Entry, filed, stuck } from '../drift.ts'
import { conflicted, git, maybe, SELF } from '../workspace.ts'

const schema = join(import.meta.dirname, '../../schema')
const NOW = new Date('2026-10-03T10:00:00Z')
const COO = { name: 'coo_lite', switch: { key: 'coo_lite.apply', value: '1' }, table: 'events', column: 'at', where: "kind = 'coo_lite'", gap: '2d' }
const REGISTRY = z.array(Entry).parse(parse(readFileSync(join(import.meta.dirname, '../../rules/registry.yaml'), 'utf8')))
const GARDENER = REGISTRY.filter((e) => e.name === 'gardener')
const STALE = [{ name: 'gardener', state: 'stale', detail: 'newest gardens.day is 2026-09-28, older than 2d' }]

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
  expect(REGISTRY.map((e) => e.name)).toEqual(['coo_lite', 'orchestrator', 'fixer', 'brief_writer', 'text_review',
    'growth_lead', 'gardener', 'ratchet', 'accounts', 'records', 'dispositions', 'signoffs', 'proposals',
    'ratchet_refuse', 'intake', 'stuck_plans'])
  expect(ratchetRules(d).mode).toBe('refuse')
  expect(drift(d, REGISTRY, NOW).map((r) => r.name)).not.toContain('ratchet_refuse')
  for (const bad of [{ gap: '2 days' }, { table: 'events;' }, { column: 'At' }]) {
    expect(() => Entry.parse({ name: 'x', ...bad })).toThrow()
  }
})

test('proposals', () => {
  const d = db()
  const proposals = REGISTRY.filter((e) => e.name === 'proposals')
  expect(drift(d, proposals, NOW)).toEqual([{ name: 'proposals', state: 'silent', detail: "no row in approvals WHERE subject_kind = 'proposal'" }])
  decide(d, 'proposal', 1, 'a'.repeat(64), 'no')
  expect(drift(d, proposals, NOW)).toEqual([])
})

function internal(enabled = 1, max = 2): Db {
  const d = fresh(schema)
  d.exec(`INSERT INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('internal', ${String(enabled)}, '00:00', '23:59', ${String(max)});
    INSERT INTO gardens (day, metric, url) VALUES ('2026-09-28', 'prepare', 'https://github.com/a/b/issues/9')`)
  return d
}

function queue(d: Db, priority: number): void {
  d.exec(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT id FROM pipes WHERE name = 'internal'), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/1', 0, ${String(priority)})`)
}

test('gardenerWhile', () => {
  expect(drift(internal(), GARDENER, NOW)).toEqual(STALE)
  const busy = internal()
  queue(busy, 1)
  expect(drift(busy, GARDENER, NOW)).toEqual([])
  const full = internal(1, 1)
  queue(full, 3)
  expect(drift(full, GARDENER, NOW)).toEqual([])
  const open = internal()
  for (const n of [11, 12]) {
    open.exec(`INSERT INTO gardens (day, metric, url) VALUES ('2026-09-${String(n)}', 'prepare', 'https://github.com/a/b/issues/${String(n)}');
      INSERT INTO tickets (repo, number, title, lane) VALUES ('a/b', ${String(n)}, 't', 'machine')`)
  }
  expect(drift(open, GARDENER, NOW)).toEqual([])
  open.exec("UPDATE tickets SET closed_at = '2026-10-01' WHERE number = 11")
  expect(drift(open, GARDENER, NOW)).toEqual(STALE)
  const none = internal()
  none.exec("DELETE FROM pipes WHERE name = 'internal'")
  expect(drift(none, GARDENER, NOW)).toEqual([])
  expect(drift(internal(0), GARDENER, NOW)).toEqual([])
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

const STUCK = [{ name: 'stuck_plans', gap: '1h' }]
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)

function stalling(): { d: Db; root: string } {
  const d = db()
  d.exec("UPDATE plans SET state = 'running', step = 3, wait_reason = 'lane_over_cap'")
  return { d, root: mkdtempSync(join(tmpdir(), 'stuck-')) }
}

test('stuckOnce', () => {
  const { d, root } = stalling()
  event(d, '2026-10-03 09:00:00')
  expect(stuck(d, root, STUCK, at(0))).toEqual([])
  expect(stuck(d, root, STUCK, at(30))).toEqual([])
  expect(stuck(d, root, STUCK, at(61))).toEqual([1])
  const note = 'step 3 and its tree unchanged for 61 min while the tick ran; waits: lane_over_cap; last: m'
  expect(d.prepare('SELECT state, held_by, held_why FROM plans WHERE id = 1').get())
    .toEqual({ state: 'blocked_on_ceo', held_by: 'coo', held_why: note })
  expect(maybe(root, 1, 'refusal.md')).toBe(`\n# Stopped\n\n${note}.\n`)
  expect(d.prepare("SELECT count(*) AS n FROM events WHERE kind = 'stuck'").get()).toEqual({ n: 1 })
  expect(stuck(d, root, STUCK, at(62))).toEqual([])
})

test('stuckRestarts', () => {
  const { d, root } = stalling()
  const src = join(root, '.cf/work/1/src')
  mkdirSync(src, { recursive: true })
  git(src, ['init', '-q'])
  writeFileSync(join(src, 'a'), 'a')
  expect(stuck(d, root, STUCK, at(0))).toEqual([])
  d.exec('UPDATE plans SET step = 4')
  expect(stuck(d, root, STUCK, at(30))).toEqual([])
  expect(stuck(d, root, STUCK, at(61))).toEqual([])
  writeFileSync(join(src, 'b'), 'b')
  expect(stuck(d, root, STUCK, at(90))).toEqual([])
})

test('stuckMerging', () => {
  const { d, root } = stalling()
  const src = join(root, '.cf/work/1/src')
  mkdirSync(src, { recursive: true })
  const commit = (body: string): string => {
    writeFileSync(join(src, 'a'), body)
    return git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', body])
  }
  git(src, ['init', '-q', '-b', 'main'])
  writeFileSync(join(src, 'a'), 'a')
  git(src, ['add', 'a'])
  commit('a')
  git(src, ['checkout', '-qb', 'other'])
  commit('b')
  git(src, ['checkout', '-q', 'main'])
  commit('c')
  expect(() => git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', 'other'])).toThrow()
  for (const minutes of [0, 30]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(conflicted(src)).toBe(true)
  expect(stuck(d, root, STUCK, at(61))).toEqual([1])
})

test('stuckNever', () => {
  const { d, root } = stalling()
  expect(stuck(d, root, STUCK, at(0))).toEqual([])
  expect(stuck(d, root, STUCK, at(120))).toEqual([])
  d.exec(`UPDATE plans SET wait_reason = 'ceo_batch';
    INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT min(id) FROM pipes), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/2', 0, 3),
      ((SELECT min(id) FROM pipes), 'pr_path', 'running', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/3', 3, 3),
      ((SELECT min(id) FROM pipes), 'pr_path', 'done', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/4', 3, 3)`)
  take(d, 3, at(120))
  for (const minutes of [120, 150, 181]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
})

test('stuckOff', () => {
  const { d, root } = stalling()
  expect(drift(d, STUCK, NOW)).toEqual([])
  expect(stuck(d, root, [COO], NOW)).toEqual([])
  expect(maybe(root, 1, 'stuck.json')).toBeNull()
})
