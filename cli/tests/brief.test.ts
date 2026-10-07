import { Command } from 'commander'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../checks/sqlite.ts'
import { registerLanes } from '../cf-lanes.ts'
import { registerPlans } from '../cf-plans.ts'
import { actors, actorSection, costs, costSection, fileWaits, greptileLine, hands, heldBy, line, misses, missSection, rulings, section, ticketSection,
  tickets, unpriced, waitLine, waits } from '../brief.ts'
import { refusalDays, refusalSection } from '../refusals.ts'
import { directorSection, handUpLine } from '../director.ts'
import { decisionSection, driftSection } from '../drift.ts'
import { hold } from '../../sequencer/hold.ts'
import { monthly, reviewed } from '../../sequencer/ready.ts'
import { put } from '../../sequencer/workspace.ts'
import { decided, directorDays } from '../../store/decisions.ts'
import { addFinding, closeFinding, type Finding, overdue, week } from '../../store/drift.ts'
import { addPrice, addRun } from '../../store/brief.ts'
import { type Event, handUps, logged, repriced } from '../../store/events.ts'
import { record as listFiles } from '../../store/files.ts'
import { holdOf } from '../../store/holds.ts'
import { addRule, type Db, spied } from '../../store/index.ts'
import { keep } from '../../store/merges.ts'
import { held, holdOn, needsCeo, parked, planById, type PlanRow, putPlan, waiting } from '../../store/plans.ts'
import { record } from '../../store/signals.ts'
import { addAccount, addTarget } from '../../store/targets.ts'

const schema = join(import.meta.dirname, '../../schema')

const HASH = 'a'.repeat(64)

/** `runs_reviewer_not_builder` refuses a reviewer who built, so each step here runs under its own seat. */
const SEATS: Record<number, string> = { 2: 'typescript_specialist', 4: 'code_quality', 5: 'senior_review' }

function world(): Db {
  const db = fresh(schema)
  for (const seat of [...Object.values(SEATS), 'orchestrator', 'coo_lite', 'director', 'fixer']) {
    addRule(db, { id: seat, kind: 'card', path: 'seats/seat.md', content_hash: HASH, loaded_at: '2026-09-19' })
  }
  addAccount(db, { id: 1, repo: 'acme/widget', measured_at: '2026-09-19', maintainers: 2, doors: 1, last_outsider_merge: '2026-09-19',
    open_pr_age_p50_days: 3, cross_repo_activity: 4, pulse: 'warm', evidence: 'https://github.com/acme/widget' })
  addTarget(db, { account_id: 1, repo: 'acme/widget', issue_no: 12, named_merger: 'maintainer', state: 'ready',
    evidence_measured_at: '2026-09-19', evidence: 'https://github.com/acme/widget/issues/12' })
  return db
}

function plan(db: Db, id: number, state: PlanRow['state'], issue: number | null, target: number | null = null): void {
  const origin = issue === null ? null : `https://github.com/caliperforge/caliperforge/issues/${String(issue)}`
  putPlan(db, { id, pipe_id: 1, target_id: target, template: issue === null ? 'research' : 'pr_path', state,
    queued_at: '2026-09-19T00:00:00.000Z', step: 0, retries: 0, lane: issue === null ? null : 'machine', seat: 'typescript_specialist', origin })
}

const RUN = { rule_hash: HASH, provider: 'claude-agent-sdk', model: 'opus', effort: 'high', cache_write_tokens: null,
  cache_write_1h_tokens: null, exit: 0, transcript_path: 'x.transcript.jsonl' }

function run(db: Db, plan: number, step: number, at: string, seconds = 60, tokens = 100, seat = String(SEATS[step]),
  cost: number | null = null): void {
  addRun(db, { ...RUN, plan, step, seat, input_tokens: tokens, cache_read_tokens: 0, output_tokens: 0, seconds, at, cost_usd: cost })
}

const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')

const NOW = new Date('2026-09-20T12:00:00.000Z')

function event(db: Db, actor: string, kind: string, at = '2026-09-20 11:00:00', id = 1, outcome: Event['outcome'] = 'pass'): void {
  logged(db, { plan: id, kind, actor, outcome, message: '', pointer: null, run: null }, at)
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
    { actor: 'director', kinds: [{ kind: 'coo_lite', n: 1 }], runs: { runs: 2, cost: 1.5 } },
    { actor: 'orchestrator', kinds: [{ kind: 'return', n: 1 }], runs: { runs: 0, cost: 0 } },
    { actor: 'fixer', kinds: [], runs: { runs: 2, cost: 0.25 } },
  ])
})

test('hand PRs merged in window: 3 home repos, searched a day back', () => {
  const seen: string[][] = []
  expect(hands(NOW, (args) => { seen.push(args); return merged })).toBe(6)
  expect(seen.map((a) => a[a.indexOf('--repo') + 1]))
    .toEqual(['caliperforge/caliperforge', 'caliperforge/atelier-web', 'caliperforge/v4-hook-index'])
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
    '  director\t1 intervention(s)\tcoo_lite 1\t2 run(s)\t$1.50\theld 0 missed 0 open 1\n' +
    '  orchestrator\t1 intervention(s)\treturn 1\t0 run(s)\t$0.00\theld 0 missed 0 open 1\n' +
    '  fixer\t0 intervention(s)\t-\t2 run(s)\t$0.25\theld 0 missed 0 open 0\n' +
    '  hand PRs merged\t6\n')
})

const IN = '2026-09-20 11:00:00'

test('D1 director line: decided, handed up, rate over 7 d', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  event(db, 'coo_lite', 'coo_lite')
  event(db, 'coo_lite', 'coo_lite', '2026-09-14 12:00:00')
  event(db, 'coo_lite', 'coo_lite', IN, 1, 'needs_ceo')
  event(db, 'coo_lite', 'coo_lite', '2026-09-12 12:00:00', 1, 'needs_ceo')
  expect(handUpLine(handUps(db, NOW))).toBe('director: 2 decided, 1 handed up (33%) over 7 d\n')
})

test('D2 no director events prints 0%, not NaN%', () => {
  expect(handUpLine(handUps(world(), NOW))).toBe('director: 0 decided, 0 handed up (0%) over 7 d\n')
})

test('D3 events of another kind count in neither number', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  event(db, 'coo_lite', 'retry')
  event(db, 'coo_lite', 'stuck', IN, 1, 'needs_ceo')
  expect(handUps(db, NOW)).toEqual({ decided: 0, up: 0 })
})

test('directorSection by day', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  plan(db, 2, 'refused', 30)
  plan(db, 3, 'running', 31)
  event(db, 'director', 'director', IN, 1)
  event(db, 'coo_lite', 'coo_lite', '2026-09-20 10:00:00', 2, 'needs_ceo')
  event(db, 'director', 'director', '2026-09-18 10:00:00', 3)
  event(db, 'director', 'retry')
  event(db, 'director', 'director', '2026-09-13 12:00:00')
  for (const verb of ['ask_coo', 'retry'] as const) {
    decided(db, { plan: 3, step: 2, wait_reason: 'blocked_on_ceo', verb, why: 'x', evidence: null, tokens: 0 }, '2026-09-20 09:00:00')
  }
  const none = '0 seen\t0 decided\t0 to fixer\t0 to ceo\theld 0 missed 0\n'
  expect(directorSection(directorDays(db, NOW), NOW)).toBe('director by day, last 7 d\n' +
    `  2026-09-14\t${none}  2026-09-15\t${none}  2026-09-16\t${none}  2026-09-17\t${none}` +
    '  2026-09-18\t1 seen\t1 decided\t0 to fixer\t0 to ceo\theld 0 missed 0\n' +
    `  2026-09-19\t${none}` +
    '  2026-09-20\t2 seen\t1 decided\t1 to fixer\t1 to ceo\theld 1 missed 1\n')
})

test('each actor scores the past week, not an event 8 days old', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  plan(db, 2, 'refused', 30)
  plan(db, 3, 'running', 31)
  for (const actor of ['ceo', 'coo', 'director', 'orchestrator', 'fixer']) {
    for (const id of [1, 2, 3]) event(db, actor, 'retry', '2026-09-14 12:00:00', id)
  }
  event(db, 'ceo', 'retry', '2026-09-12 12:00:00', 3)
  expect(actors(db, NOW).map((r) => r.scored)).toEqual(Array.from({ length: 5 }, () => ({ held: 1, missed: 1, open: 1 })))
})

test('oldActorScored', () => {
  const db = world()
  plan(db, 1, 'done', 25)
  event(db, 'coo_lite', 'retry', '2026-09-14 12:00:00')
  run(db, 1, 3, '2026-09-20 09:00:00', 60, 100, 'coo_lite')
  const rows = actors(db, NOW)
  expect(rows.find((r) => r.actor === 'director')).toMatchObject({ runs: { runs: 1 }, scored: { held: 1, missed: 0, open: 0 } })
  expect(rows.map((r) => r.actor)).not.toContain('coo_lite')
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
  expect(tickets(spied(db, seen))).toHaveLength(1)
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

function review(db: Db, id: number, repo: string, author: string, at: string, plan: number, score = 4, head: string | null = null): void {
  record(db, { repo, pr: 3, kind: 'bot_review', author, at, external_id: `g${String(id)}`, score, plan, head })
}

test('D1 D2 Greptile rehearsal reviews of this UTC month count', () => {
  const db = world()
  const now = new Date('2026-10-02T12:00:00.000Z')
  plan(db, 1, 'running', null, 1)
  plan(db, 2, 'running', 25)
  review(db, 1, 'acme/widget', 'greptile-apps', '2026-10-02T09:00:00Z', 1)
  review(db, 2, 'caliperforge/widget', 'greptile-apps', '2026-10-02T09:00:00Z', 2)
  review(db, 3, 'caliperforge/widget', 'coderabbitai', '2026-10-02T09:00:00Z', 1)
  review(db, 4, 'caliperforge/widget', 'greptile-apps', '2026-08-31T23:59:59Z', 1)
  expect(reviewed(db, now)).toBe(0)
  review(db, 5, 'caliperforge/widget', 'greptile-apps', '2026-10-01T09:00:00Z', 1)
  expect(reviewed(db, now)).toBe(1)
  review(db, 6, 'caliperforge/widget', 'greptile-apps', '2026-10-02T09:00:00Z', 1)
  expect(reviewed(db, now)).toBe(2)
})

const HEAD = 'a'.repeat(40)

const MISSED = 'greptile after both reviewers passed, last 30 d\n'

function passed(db: Db, id: number, path: string, gates = ['review', 'senior_review']): void {
  listFiles(db, id, [{ path, is_new: false }])
  for (const gate of gates) keep(db, id, gate === 'review' ? 4 : 5, gate, { id: 0, outcome: 'pass', subject_digest: HASH, tree: null }, null)
}

function rehearsals(): { db: Db; root: string; now: Date } {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-misses-'))
  plan(db, 1, 'running', null, 1)
  plan(db, 2, 'running', null, 1)
  passed(db, 1, 'kotlin/src/main/kotlin/Client.kt')
  passed(db, 2, 'python/client.py')
  review(db, 1, 'caliperforge/widget', 'greptile-apps', '2026-10-01T09:00:00Z', 1, 2, HEAD)
  review(db, 2, 'caliperforge/widget', 'greptile-apps', '2026-10-01T09:00:00Z', 2, 5, HEAD)
  put(root, 1, `findings-${HEAD}.md`, [1, 2, 3, 4].map((n) => `- G${String(n)} a finding\n`).join(''))
  return { db, root, now: new Date('2026-10-02T12:00:00.000Z') }
}

const FIXTURE = `${MISSED}  kotlin 1 passed, 1 marked down, 4 findings\n  python 1 passed, 0 marked down\n`

test('D1 per language: passed, marked down and findings', () => {
  const { db, root, now } = rehearsals()
  expect(missSection(misses(db, root, now))).toBe(FIXTURE)
})

test('D2 no senior pass, stale, internal, other bot or repo', () => {
  const { db, root, now } = rehearsals()
  plan(db, 3, 'running', null, 1)
  passed(db, 3, 'python/other.py', ['review'])
  review(db, 3, 'caliperforge/widget', 'greptile-apps', '2026-10-01T09:00:00Z', 3, 2, HEAD)
  review(db, 4, 'caliperforge/widget', 'greptile-apps', '2026-08-01T09:00:00Z', 1, 2, 'b'.repeat(40))
  plan(db, 4, 'running', 25)
  passed(db, 4, 'cli/brief.ts')
  review(db, 5, 'caliperforge/caliperforge', 'greptile-apps', '2026-10-01T09:00:00Z', 4, 2, HEAD)
  review(db, 6, 'caliperforge/widget', 'coderabbitai', '2026-10-01T09:00:00Z', 1, 2, 'c'.repeat(40))
  review(db, 7, 'acme/widget', 'greptile-apps', '2026-10-01T09:00:00Z', 1, 2, 'd'.repeat(40))
  expect(missSection(misses(db, root, now))).toBe(FIXTURE)
})

test('D3 two scores at one head are one head; the newer decides', () => {
  const { db, root, now } = rehearsals()
  review(db, 3, 'caliperforge/widget', 'greptile-apps', '2026-10-02T09:00:00Z', 1, 5, HEAD)
  expect(missSection(misses(db, root, now))).toContain('  kotlin 1 passed, 0 marked down\n')
})

test('D3 findings repeated on a later head count once', () => {
  const { db, root, now } = rehearsals()
  const next = 'e'.repeat(40)
  review(db, 3, 'caliperforge/widget', 'greptile-apps', '2026-10-02T09:00:00Z', 1, 2, next)
  put(root, 1, `findings-${next}.md`, [1, 2, 3, 4].map((n) => `- G${String(n)} a finding\n`).join(''))
  expect(missSection(misses(db, root, now))).toContain('  kotlin 2 passed, 2 marked down, 4 findings\n')
})

test('D4 no counted head prints none', () => {
  expect(missSection(misses(world(), mkdtempSync(join(tmpdir(), 'cf-misses-')), new Date()))).toBe(`${MISSED}  none\n`)
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

test('target approval holds a plan on the CEO until reason clears', () => {
  const db = world()
  plan(db, 1, 'queued', null, 1)
  waiting(db, [{ plan: 1, why: 'target_approval' }])
  expect(holdOf(db, 1)).toEqual({ held_by: 'ceo', held_why: 'target_approval' })
  waiting(db, [{ plan: 1, why: null }])
  expect(holdOf(db, 1)).toEqual({ held_by: null, held_why: null })
})

test('heldBy lists each held plan under who it waits on, with why', () => {
  const db = world()
  plan(db, 1, 'queued', null, 1)
  plan(db, 2, 'queued', 30)
  plan(db, 3, 'queued', 31)
  waiting(db, [{ plan: 1, why: 'target_approval' }])
  holdOn(db, 2, '', null)
  expect(heldBy(db, 'ceo').map(line)).toEqual(['  plan 1\tstep 0\tqueued\tacme/widget#12\ttarget_approval'])
  expect(heldBy(db, 'coo').map(line)).toEqual(['  plan 2\tstep 0\tblocked_on_ceo\t-'])
})

test('parked on another: listed with it, not as needing a decision', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'queued', 30)
  hold(db, mkdtempSync(join(tmpdir(), 'cf-parked-')), 2, 'after #30', new Date(), 1)
  expect(section('parked on another job', parked(db)))
    .toBe('parked on another job (1)\n  plan 2\tstep 0\tblocked_on_ceo\t-\tuntil plan 1 lands (queued, step 0)\n')
  expect(heldBy(db, 'coo')).toEqual([])
})

const LAPSES = new Date('2026-10-05T04:00:00.000Z')

test('D1 a time hold needs a decision with its time, not its why', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  hold(db, mkdtempSync(join(tmpdir(), 'cf-until-')), 1, 'wait a day', new Date(), null, LAPSES)
  held(db, 1, 'coo', 'wait a day')
  expect(heldBy(db, 'coo').map(line)).toEqual(['  plan 1\tstep 0\tblocked_on_ceo\t-\tuntil 10-04 22:00'])
})

test('D3 cf plan <id> ends the plan row with the hold\'s condition', () => {
  const db = world()
  const root = mkdtempSync(join(tmpdir(), 'cf-until-'))
  plan(db, 1, 'queued', 25)
  plan(db, 2, 'queued', 30)
  plan(db, 3, 'queued', 31)
  hold(db, root, 1, 'wait a day', new Date(), null, LAPSES)
  hold(db, root, 2, 'after #31', new Date(), 3)
  const printed: string[] = []
  const cf = new Command()
  registerPlans(cf, { root, db: () => db, out: (text: string) => { printed.push(text) } })
  cf.parse(['plan', '1'], { from: 'user' })
  expect(printed[0]).toMatch(/\tuntil 10-04 22:00\n$/)
  printed.length = 0
  cf.parse(['plan', '2'], { from: 'user' })
  expect(printed[0]).toMatch(/\tuntil plan 3 lands\n$/)
})

test('a blocked plan with no park needs a decision with its stop', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  needsCeo(db, planById(db, 1), 'code_quality refused: x')
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
  const seed = (input: number, write: number | null, read: number, output: number): void => {
    addRun(db, { ...RUN, plan: 1, step: 2, seat: 'typescript_specialist', input_tokens: input, cache_write_tokens: write,
      cache_read_tokens: read, output_tokens: output, seconds: 60, at: ago(1), cost_usd: null })
  }
  seed(10, null, 200, 3)
  seed(14, 4, 20, 5)
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
  addPrice(db, { provider: 'claude-agent-sdk', model, input: 1, cache_read: 0.1, cache_write: 2, cache_write_1h: 2, output: 10,
    effective_from: '2026-01-01', source_url: 'https://example.com/prices' })
}

function costed(db: Db, model: string, hours: number, input: number, write: number, read: number, output: number, usd: number): void {
  addRun(db, { ...RUN, plan: 1, step: 2, seat: 'typescript_specialist', model, input_tokens: input, cache_write_tokens: write,
    cache_write_1h_tokens: write, cache_read_tokens: read, output_tokens: output, cost_usd: usd, seconds: 60, at: ago(hours) })
}

function twoModels(): Db {
  const db = world()
  plan(db, 1, 'running', 25)
  priced(db, 'opus')
  costed(db, 'opus', 1, 1000, 200, 5000, 300, 0.01)
  costed(db, 'haiku', 1, 500, 100, 1000, 50, 0.002)
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
  costed(db, 'opus', 48, 9000, 900, 9000, 900, 9)
  repriced(db)
  expect(costSection(costs(db), unpriced(db))).toBe('cost last 24 h by model (2)\n' +
    '  claude-agent-sdk/haiku\t1 run(s)\t400 uncached\t100 cache write\t1000 cache read\t50 output\tcomputed $0.0012\treported $0.0020\n' +
    '  claude-agent-sdk/opus\t1 run(s)\t800 uncached\t200 cache write\t5000 cache read\t300 output\tcomputed $0.0047\treported $0.0100\n')
})

test('D4 an empty day prints none', () => {
  const db = world()
  expect(costSection(costs(db), unpriced(db))).toBe('cost last 24 h by model (0)\n  none\n')
})

function refusal(db: Db, plan: number, at: string, span: string, note: string | null, step = 1, blip = 0): void {
  db.exec(`INSERT INTO refusals (plan, step, fingerprint, blip, at, span, note) VALUES (${String(plan)}, ${String(step)},
    '${HASH}', ${String(blip)}, '${at}', '${span}', ${note === null ? 'NULL' : `'${note}'`})`)
}

test('D3-D6 seven days of step 1 refusals by reason, oldest first', () => {
  const db = world()
  plan(db, 1, 'running', 25)
  plan(db, 2, 'running', null)
  db.exec("UPDATE plans SET template = 'comms' WHERE id = 2")
  refusal(db, 1, '2026-09-20 09:00:00', 'a.ts', 'brief_writer: a.ts is not in the checkout')
  refusal(db, 1, '2026-09-20 10:00:00', 'b.ts', 'brief_writer: b.ts is not in the checkout')
  refusal(db, 1, '2026-09-20 11:00:00', 'brief.wide', 'brief_writer: 412 lines over 300')
  refusal(db, 1, '2026-09-18 08:00:00', 'a.ts', null)
  refusal(db, 1, '2026-09-20 11:00:00', 'a.ts', 'brief_writer: blip', 1, 1)
  refusal(db, 1, '2026-09-20 11:00:00', 'a.ts', 'typescript_specialist: step 3', 3)
  refusal(db, 2, '2026-09-20 11:00:00', 'a.ts', 'brief_writer: comms')
  refusal(db, 1, '2026-09-12 12:00:00', 'a.ts', 'brief_writer: old')
  expect(refusalSection(refusalDays(db, NOW))).toBe('brief writer refusals last 7 d\n' +
    '  2026-09-14\t0\tnone\n  2026-09-15\t0\tnone\n  2026-09-16\t0\tnone\n  2026-09-17\t0\tnone\n' +
    '  2026-09-18\t1\tunrecorded 1\n  2026-09-19\t0\tnone\n' +
    '  2026-09-20\t3\t<span> is not in the checkout 2\tn lines over n 1\n')
})

function found(db: Db, name: string, hours: number, outcome?: NonNullable<Finding['outcome']>): void {
  const id = addFinding(db, { name, state: 'off', detail: `${name} is off` }, new Date(at(hours)))
  if (outcome !== undefined) closeFinding(db, Number(id), outcome, 'x', null, NOW)
}

test('D1 drift counts findings of 7 days by outcome', () => {
  const db = world()
  found(db, 'hq', 1, 'fixed')
  found(db, 'desk', 30, 'fixed')
  found(db, 'site', 50, 'covered')
  found(db, 'watch', 100, 'retire')
  found(db, 'flow', 150, 'defect')
  found(db, 'old', 192, 'fixed')
  expect(driftSection(week(db, NOW))).toBe('drift last 7 d\t5 found → 2 fixed\t1 covered\t1 retire\t1 defect\n')
})

test('D2 no finding in 7 days reads zero', () => {
  expect(driftSection(week(world(), NOW))).toBe('drift last 7 d\t0 found → 0 fixed\t0 covered\t0 retire\t0 defect\n')
})

test('D3 a finding open past 24 h needs a decision', () => {
  const db = world()
  plan(db, 1, 'blocked_on_ceo', 25)
  held(db, 1, 'coo', 'stop')
  found(db, 'hq', 25)
  found(db, 'desk', 23)
  found(db, 'site', 30, 'fixed')
  expect(decisionSection(heldBy(db, 'coo'), overdue(db, NOW), NOW))
    .toBe('needs a decision (2)\n  plan 1\tstep 0\tblocked_on_ceo\t-\tstop\n  finding 1\thq\toff\t25 h\thq is off\n')
})

test('D4 no held plan and no overdue finding prints none', () => {
  const db = world()
  expect(decisionSection(heldBy(db, 'coo'), overdue(db, NOW), NOW)).toBe('needs a decision (0)\n  none\n')
})

test('with no waiting live plan the waits line reads none', () => {
  const db = world()
  plan(db, 1, 'queued', 25)
  expect(waitLine(waits(db))).toBe('waits\tnone\n')
})
