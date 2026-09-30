import { Command } from 'commander'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { registerLanes } from '../cf-lanes.ts'
import { actors, actorSection, costs, costSection, fileWaits, greptileLine, hands, heldBy, line, rulings, section, ticketSection, tickets, unpriced,
  waitLine, waits } from '../brief.ts'
import { hold } from '../../sequencer/hold.ts'
import { monthly } from '../../sequencer/ready.ts'
import { put } from '../../sequencer/workspace.ts'
import { repriced } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { needsCeo, parked, PlanRow, waiting } from '../../store/plans.ts'

const schema = join(import.meta.dirname, '../../schema')

const HASH = 'a'.repeat(64)

/** `runs_reviewer_not_builder` refuses a reviewer who built, so each step here runs under its own seat. */
const SEATS: Record<number, string> = { 2: 'typescript_specialist', 4: 'code_quality', 5: 'senior_review' }

function world(): Db {
  const db = fresh(schema)
  for (const seat of [...Object.values(SEATS), 'orchestrator', 'coo_lite', 'fixer']) {
    db.prepare("INSERT INTO rules VALUES (?, 'card', 'seats/seat.md', ?, '2026-09-19')").run(seat, HASH)
  }
  db.prepare(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge,
    open_pr_age_p50_days, cross_repo_activity, pulse, evidence)
    VALUES (1, 'acme/widget', '2026-09-19', 2, 1, '2026-09-19', 3, 4, 'warm', 'https://github.com/acme/widget')`).run()
  db.prepare(`INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/widget', 12, 'maintainer', 'ready', '2026-09-19', 'https://github.com/acme/widget/issues/12')`).run()
  return db
}

function plan(db: Db, id: number, state: string, issue: number | null, target: number | null = null): void {
  const origin = issue === null ? null : `https://github.com/caliperforge/caliperforge/issues/${String(issue)}`
  db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, lane, seat, origin)
    VALUES (?, 1, ?, ?, ?, '2026-09-19T00:00:00.000Z', ?, 'typescript_specialist', ?)`)
    .run(id, target, issue === null ? 'research' : 'pr_path', state,
      issue === null ? null : 'machine', origin)
}

function run(db: Db, plan: number, step: number, at: string, seconds = 60, tokens = 100, seat = SEATS[step],
  cost: number | null = null): void {
  db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path, cost_usd)
    VALUES (?, ?, ?, ?, 'claude-agent-sdk', 'opus', 'high', ?, 0, 0, ?, 0, ?, 'x.transcript.jsonl', ?)`)
    .run(plan, step, seat, HASH, tokens, seconds, at, cost)
}

const NOW = new Date('2026-09-20T12:00:00.000Z')

function event(db: Db, actor: string, kind: string, at = '2026-09-20 11:00:00', id = 1): void {
  db.prepare("INSERT INTO events (plan, at, kind, actor, outcome, message) VALUES (?, ?, ?, ?, 'pass', '')").run(id, at, kind, actor)
}

function day24(): Db {
  const db = world()
  plan(db, 1, 'running', 25)
  event(db, 'ceo', 'retry')
  event(db, 'ceo', 'return')
  event(db, 'ceo', 'retry', '2026-09-19 11:00:00')
  event(db, 'orchestrator', 'return')
  event(db, 'coo_lite', 'coo_lite')
  for (const actor of ['split', 'ciChecks', 'token_ceiling', 'cf plan add']) event(db, actor, 'filed')
  run(db, 1, 3, '2026-09-20 09:00:00', 60, 100, 'coo_lite', 1)
  run(db, 1, 3, '2026-09-20 10:00:00', 60, 100, 'coo_lite', 0.5)
  run(db, 1, 3, '2026-09-19 11:00:00', 60, 100, 'coo_lite', 4)
  run(db, 1, 3, '2026-09-20 10:00:00', 60, 100, 'fixer', 0.25)
  run(db, 1, 3, '2026-09-20 11:00:00', 60, 100, 'fixer')
  run(db, 1, 2, '2026-09-20 11:00:00', 60, 100, 'typescript_specialist', 9)
  return db
}

const at = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

const merged = [
  { headRefName: 'hand-a', mergedAt: at(1) },
  { headRefName: 'hand-b', mergedAt: at(23) },
  { headRefName: 'hand-c', mergedAt: at(25) },
  { headRefName: 'p12-thing', mergedAt: at(1) },
]

test('each actor counts its own events and seat runs over 24 h', () => {
  expect(actors(day24(), NOW)).toMatchObject([
    { actor: 'ceo', kinds: [{ kind: 'retry', n: 1 }, { kind: 'return', n: 1 }], runs: null },
    { actor: 'coo', kinds: [], runs: null },
    { actor: 'coo_lite', kinds: [{ kind: 'coo_lite', n: 1 }], runs: { runs: 2, cost: 1.5 } },
    { actor: 'orchestrator', kinds: [{ kind: 'return', n: 1 }], runs: { runs: 0, cost: 0 } },
    { actor: 'fixer', kinds: [], runs: { runs: 2, cost: 0.25 } },
  ])
})

test('hand PRs merged in window: 3 home repos, searched a day back', () => {
  const seen: string[][] = []
  expect(hands(NOW, (args) => { seen.push(args); return merged })).toBe(6)
  expect(seen.map((a) => a[a.indexOf('--repo') + 1]))
    .toEqual(['caliperforge/caliperforge', 'caliperforge/atelier', 'caliperforge/v4-hook-index'])
  for (const a of seen) expect(a).toContain('merged:>=2026-09-19')
})

test('D5 a full page of merged PRs throws, naming the repo', () => {
  const full = Array.from({ length: 100 }, () => merged[0])
  expect(() => hands(NOW, () => full)).toThrow(/caliperforge\/caliperforge lists 100 merged PRs/)
})

test('D6 the fixture day renders the expected section exactly', () => {
  expect(actorSection(actors(day24(), NOW), hands(NOW, () => merged))).toBe('last 24 h by actor, held/missed/open over 7 d\n' +
    '  ceo\t2 intervention(s)\tretry 1, return 1\theld 0 missed 0 open 3\n' +
    '  coo\t0 intervention(s)\t-\theld 0 missed 0 open 0\n' +
    '  coo_lite\t1 intervention(s)\tcoo_lite 1\t2 run(s)\t$1.50\theld 0 missed 0 open 1\n' +
    '  orchestrator\t1 intervention(s)\treturn 1\t0 run(s)\t$0.00\theld 0 missed 0 open 1\n' +
    '  fixer\t0 intervention(s)\t-\t2 run(s)\t$0.25\theld 0 missed 0 open 0\n' +
    '  hand PRs merged\t6\n')
})

test('each actor scores the past week, not an event 8 days old', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  plan(db, 2, 'refused', 30)
  plan(db, 3, 'running', 31)
  for (const actor of ['ceo', 'coo', 'coo_lite', 'orchestrator', 'fixer']) {
    for (const id of [1, 2, 3]) event(db, actor, 'retry', '2026-09-14 12:00:00', id)
  }
  event(db, 'ceo', 'retry', '2026-09-12 12:00:00', 3)
  expect(actors(db, NOW).map((r) => r.scored)).toEqual(Array.from({ length: 5 }, () => ({ held: 1, missed: 1, open: 1 })))
})

test('a step 4 orchestrator run adds runs and tokens, not review', () => {
  const db = world()
  plan(db, 1, 'blocked_on_ceo', 25)
  run(db, 1, 2, '2026-09-20 09:00:00')
  run(db, 1, 4, '2026-09-20 10:00:00', 60, 100, 'orchestrator')
  expect(tickets(db)).toMatchObject([{ runs: 2, build: 1, review: 0, tokens: 200 }])
})

test('plan rows newest run first: rounds, minutes, tokens, outcome', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  plan(db, 2, 'running', 30)
  run(db, 1, 2, '2026-09-20 09:00:00', 90, 500)
  run(db, 1, 2, '2026-09-20 09:30:00', 30, 250)
  run(db, 1, 4, '2026-09-20 10:00:00', 60, 250)
  run(db, 1, 5, '2026-09-20 10:30:00', 60, 1000)
  run(db, 2, 2, '2026-09-21 08:00:00', 120, 400)
  expect(ticketSection(tickets(db))).toBe('cost per ticket (2)\n' +
    '  #30\t1 run(s)\t1 build\t0 review\t2.0 min\t400 tokens\topen\n' +
    '  #25\t4 run(s)\t2 build\t2 review\t4.0 min\t2000 tokens\tlanded\n' +
    '  before 2026-09-19 11:21\t0 ticket(s)\t- avg\n' +
    '  since 2026-09-19 11:21\t2 ticket(s)\t3.0 min avg\n')
})

test('halted/refused plans are wasted; eras average own tickets', () => {
  const db = world()
  plan(db, 1, 'halted', 25)
  plan(db, 2, 'refused', 30)
  run(db, 1, 2, '2026-09-19 11:20:59', 600)
  run(db, 2, 2, '2026-09-19 11:21:00', 120)
  const rows = tickets(db)
  expect(rows.map((t) => t.outcome)).toEqual(['wasted', 'wasted'])
  expect(ticketSection(rows)).toContain('  before 2026-09-19 11:21\t1 ticket(s)\t10.0 min avg\n')
  expect(ticketSection(rows)).toContain('  since 2026-09-19 11:21\t1 ticket(s)\t2.0 min avg\n')
})

test('no run, no row; an empty era divides by nothing', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  expect(tickets(db)).toEqual([])
  expect(ticketSection(tickets(db))).toBe('cost per ticket (0)\n  none\n' +
    '  before 2026-09-19 11:21\t0 ticket(s)\t- avg\n' +
    '  since 2026-09-19 11:21\t0 ticket(s)\t- avg\n')
})

test('no origin or target: plan id; a target: the repo issue', () => {
  const db = world()
  plan(db, 1, 'queued', null)
  plan(db, 2, 'queued', null, 1)
  run(db, 1, 2, '2026-09-20 09:00:00')
  run(db, 2, 2, '2026-09-20 08:00:00')
  expect(ticketSection(tickets(db)).split('\n').slice(1, 3))
    .toEqual(['  plan 1\t1 run(s)\t1 build\t0 review\t1.0 min\t100 tokens\topen',
      '  acme/widget#12\t1 run(s)\t1 build\t0 review\t1.0 min\t100 tokens\topen'])
})

test('tickets() reads db alone: no provider, no gh, one statement', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  run(db, 1, 2, '2026-09-20 09:00:00')
  const seen: string[] = []
  const handle = { prepare: (sql: string) => { seen.push(sql); return db.prepare(sql) } } as unknown as Db
  expect(tickets(handle)).toHaveLength(1)
  expect(tickets).toHaveLength(1)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain('FROM runs r JOIN plans p')
})

test('waits line counts live plans per stored reason, sorted', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'running', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'over_cap' }, { plan: 2, why: 'file_overlap', on: 1 }, { plan: 3, why: 'file_overlap', on: 1 }])
  expect(waitLine(waits(db))).toBe('waits\tfile_overlap 2\tover_cap 1\n')
})

test('stale reason on a blocked plan or none on a live plan adds 0', () => {
  const db = world()
  plan(db, 1, 'blocked_on_ceo', 25)
  plan(db, 2, 'queued', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'token_ceiling' }, { plan: 2, why: null }, { plan: 3, why: 'leased' }])
  expect(waitLine(waits(db))).toBe('waits\tleased 1\n')
})

test('Greptile counts dated requests of this UTC month, all plans', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-month-'))
  const now = new Date('2026-09-26T12:00:00.000Z')
  expect(monthly(root, now)).toBe(0)
  const at = (sha: string, when: string): string => `${sha.repeat(40)} ${when}\n`
  put(root, 1, 'greptile.asked', at('a', now.toISOString()).repeat(7) + at('b', '2026-08-31T23:59:59.000Z'))
  put(root, 2, 'greptile.asked', `${'c'.repeat(40)}\n` + at('d', '2026-09-01T00:00:00.000Z').repeat(5))
  expect(monthly(root, now)).toBe(12)
  expect(greptileLine(12)).toBe('greptile 12/50 this month\n')
})

test('cf brief names only plans whose ask.md drifted from brief', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-rulings-'))
  expect(rulings(db, root)).toBe('')
  plan(db, 1, 'running', 25)
  plan(db, 2, 'running', 30)
  put(root, 1, 'ask.briefed.md', '# one\n')
  put(root, 1, 'ask.md', '# one\n\n## Ruling\n')
  put(root, 2, 'ask.briefed.md', '# two\n')
  put(root, 2, 'ask.md', '# two\n')
  expect(rulings(db, root)).toContain('plan 1')
  expect(rulings(db, root)).not.toContain('plan 2')
})

test('names a held plan whose ask.md drifted, not a done one', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-rulings-'))
  plan(db, 1, 'done', 25)
  plan(db, 2, 'blocked_on_ceo', 30)
  for (const id of [1, 2]) {
    put(root, id, 'ask.briefed.md', '# ask\n')
    put(root, id, 'ask.md', '# ask\n\n## Ruling\n')
  }
  expect(rulings(db, root)).toBe('ask\tplan 2: ask.md differs from the ask its issue.md was briefed from\n')
})

const holding = (db: Db, id: number): unknown => db.prepare('SELECT held_by, held_why FROM plans WHERE id = ?').get(id)

test('target approval holds a plan on the CEO until reason clears', () => {
  const db = world()
  plan(db, 1, 'queued', null, 1)
  waiting(db, [{ plan: 1, why: 'target_approval' }])
  expect(holding(db, 1)).toEqual({ held_by: 'ceo', held_why: 'target_approval' })
  waiting(db, [{ plan: 1, why: null }])
  expect(holding(db, 1)).toEqual({ held_by: null, held_why: null })
})

test('heldBy lists each held plan under who it waits on, with why', () => {
  const db = world()
  plan(db, 1, 'queued', null, 1)
  plan(db, 2, 'queued', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'target_approval' }])
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = 2").run()
  expect(heldBy(db, 'ceo').map(line)).toEqual(['  plan 1\tstep 0\tqueued\tacme/widget#12\ttarget_approval'])
  expect(heldBy(db, 'coo').map(line)).toEqual(['  plan 2\tstep 0\tblocked_on_ceo\t-'])
})

test('parked on another: listed with it, not as needing a decision', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'queued', 30)
  hold(db, mkdtempSync(join(tmpdir(), 'cf-parked-')), 2, 'after #30', new Date(), 1)
  expect(section('parked on another job', parked(db)))
    .toBe('parked on another job (1)\n  plan 2\tstep 0\tblocked_on_ceo\t-\twaits for plan 1 (queued, step 0)\tafter #30\n')
  expect(heldBy(db, 'coo')).toEqual([])
})

test('a blocked plan with no park needs a decision with its stop', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  needsCeo(db, PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = 1').get()), 'code_quality refused: x')
  expect(heldBy(db, 'coo').map(line)).toEqual(['  plan 1\tstep 0\tblocked_on_ceo\t-\tcode_quality refused: x'])
  expect(parked(db)).toEqual([])
})

test('D3 a plan waiting on another job\'s files is not parked', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'queued', 30)
  waiting(db, [{ plan: 2, why: 'file_overlap', on: 1 }])
  expect(parked(db)).toEqual([])
})

test('files section: waiting plan, holder and file, or none', () => {
  expect(fileWaits([{ plan: 3, on: 2, path: 'x.ts' }])).toBe('waiting on files (1)\n  plan 3\ton plan 2\tx.ts\n')
  expect(fileWaits([])).toBe('waiting on files (0)\n  none\n')
})

test('runs/usage: tokens by type, null cache write 0, same totals', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  const seed = db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort,
    input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, seconds, exit, at, transcript_path)
    VALUES (1, 2, 'typescript_specialist', ?, 'claude-agent-sdk', 'opus', 'high', ?, ?, ?, ?, 60, 0, datetime('now', '-1 hour'), 'x.transcript.jsonl')`)
  seed.run(HASH, 10, null, 200, 3)
  seed.run(HASH, 14, 4, 20, 5)
  const printed: string[] = []
  const cf = new Command()
  registerLanes(cf, { root: '', db: () => db, out: (text: string) => { printed.push(text) } })
  cf.parse(['runs'], { from: 'user' })
  expect(printed).toEqual([
    '1\ttypescript_specialist\t2\t0\t213\t60.0\t10 uncached\t0 cache write\t200 cache read\t3 output\n',
    '2\ttypescript_specialist\t2\t0\t39\t60.0\t10 uncached\t4 cache write\t20 cache read\t5 output\n',
  ])
  printed.length = 0
  cf.parse(['usage'], { from: 'user' })
  const lines = printed.filter((l) => l.startsWith('  '))
  expect(lines).toHaveLength(2)
  for (const l of lines) expect(l).toContain('\t2 run(s)\t252 tokens\t20 uncached\t4 cache write\t220 cache read\t8 output\t')
})

function priced(db: Db, model: string): void {
  db.prepare(`INSERT INTO prices (provider, model, input, cache_read, cache_write, output, effective_from, source_url)
    VALUES ('claude-agent-sdk', ?, 1, 0.1, 2, 10, '2026-01-01', 'https://example.com/prices')`).run(model)
}

function costed(db: Db, model: string, ago: string, input: number, write: number, read: number, output: number, usd: number): void {
  db.prepare(`INSERT INTO runs (plan, step, seat, rule_hash, provider, model, effort, input_tokens, cache_write_tokens,
    cache_read_tokens, output_tokens, cost_usd, seconds, exit, at, transcript_path)
    VALUES (1, 2, 'typescript_specialist', ?, 'claude-agent-sdk', ?, 'high', ?, ?, ?, ?, ?, 60, 0, datetime('now', ?), 'x.transcript.jsonl')`)
    .run(HASH, model, input, write, read, output, usd, ago)
}

function twoModels(): Db {
  const db = world()
  plan(db, 1, 'running', 25)
  priced(db, 'opus')
  costed(db, 'opus', '-1 hour', 1000, 200, 5000, 300, 0.01)
  costed(db, 'haiku', '-1 hour', 500, 100, 1000, 50, 0.002)
  return db
}

test('per-model lines: computed and reported cost; unpriced named', () => {
  const db = twoModels()
  repriced(db)
  expect(costSection(costs(db), unpriced(db))).toBe('cost last 24 h by model (2)\n' +
    '  claude-agent-sdk/haiku\t1 run(s)\t400 uncached\t100 cache write\t1000 cache read\t50 output\tcomputed -\treported $0.0020\n' +
    '  claude-agent-sdk/opus\t1 run(s)\t800 uncached\t200 cache write\t5000 cache read\t300 output\tcomputed $0.0047\treported $0.0100\n' +
    '  no price row\tclaude-agent-sdk/haiku\n')
})

test('priced models get no price line; day-old runs count nowhere', () => {
  const db = twoModels()
  priced(db, 'haiku')
  costed(db, 'opus', '-2 days', 9000, 900, 9000, 900, 9)
  repriced(db)
  expect(costSection(costs(db), unpriced(db))).toBe('cost last 24 h by model (2)\n' +
    '  claude-agent-sdk/haiku\t1 run(s)\t400 uncached\t100 cache write\t1000 cache read\t50 output\tcomputed $0.0012\treported $0.0020\n' +
    '  claude-agent-sdk/opus\t1 run(s)\t800 uncached\t200 cache write\t5000 cache read\t300 output\tcomputed $0.0047\treported $0.0100\n')
})

test('D4 an empty day prints none', () => {
  const db = world()
  expect(costSection(costs(db), unpriced(db))).toBe('cost last 24 h by model (0)\n  none\n')
})

test('with no waiting live plan the waits line reads none', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  expect(waitLine(waits(db))).toBe('waits\tnone\n')
})
