import { expect, test } from 'vitest'
import { addRun } from '../../store/brief.ts'
import { eventsOf, ofKind, pointers } from '../../store/events.ts'
import { holdOf } from '../../store/holds.ts'
import { addRule, type Db } from '../../store/index.ts'
import { pipeOf, planRows, putPlan } from '../../store/plans.ts'
import { refused } from '../../store/refusals.ts'
import { hold } from '../hold.ts'
import type { Wire } from '../push.ts'
import { ticketed } from '../ticket.ts'
import { maybe, put, SELF } from '../workspace.ts'
import { internalPlan, issues, plan, world } from './world.ts'

const now = new Date('2026-10-28T12:00:00.000Z')
const BENCH = 'run_pair drops a seed (lane:bench, P0)'
const LANDED = `https://github.com/${SELF}/issues/2030`
const OPEN = `https://github.com/${SELF}/issues/2027`

interface Listed { number: number; title: string; body: string; url: string; comments?: { body: string }[] }
interface Seen { filed: { repo: string; labels: string[] }[]; amended: string[]; open: Listed[]; closed: Listed[] }

const seen = (lists: Partial<Seen> = {}): Seen => ({ filed: [], amended: [], open: [], closed: [], ...lists })

function wire(s: Seen): Wire {
  const no = (): never => { throw new Error('not in this test') }
  return { send: no, open: no, close: no, runs: no, comment: no, review: no,
    merged: issues(s.open, s.closed),
    amend: (...[, n, line]) => void s.amended.push(`#${String(n)} ${line}`),
    file: (...[repo, , , labels]) => {
      s.filed.push({ repo, labels })
      return `https://github.com/${repo}/issues/${String(900 + s.filed.length)}`
    } }
}

const waitsOn = (db: Db, id: number) => Number(planRows(db).find((r) => r.id === id)?.waits_on)

function ticket(title: string, body = 'body') {
  const { db, root } = world()
  const s = seen()
  const origin = ticketed(db, root, plan(db, 1), title, body, 'why', wire(s), now)
  return { db, root, seen: s, filed: s.filed, origin, on: waitsOn(db, 1) }
}

test('a lane:bench title files and queues in the bench lane', () => {
  const { db, filed, origin, on } = ticket(BENCH)
  expect(filed).toEqual([{ repo: 'caliperforge/fuzz-bench', labels: ['lane:bench', 'P0', 'fix'] }])
  expect(plan(db, on)).toMatchObject({ lane: 'bench', seat: 'solidity_specialist', priority: 0, state: 'queued', origin })
  expect(pipeOf(db, plan(db, on).pipe_id).name).toBe('bench')
  expect(ofKind(db, 'covered')).toMatchObject([{ actor: 'ticketed', outcome: 'pass',
    message: expect.stringMatching(new RegExp(`^compared "${BENCH.replace(/[()]/g, '\\$&')}" with 0 open, 0 landed, \\d+ registry lines: filed$`)) as string }])
  expect(pointers(db, 'covered')).toEqual([origin])
})

test.each(['the run wall counts each block', 'a stop (lane:nope)'])('"%s" is a machine ticket on SELF', (title) => {
  const { db, filed, on } = ticket(title)
  expect(filed).toEqual([{ repo: SELF, labels: ['lane:machine', 'P0', 'fix'] }])
  expect(plan(db, on)).toMatchObject({ lane: 'machine', seat: 'typescript_specialist', priority: 0 })
})

test('a second run_pair ticket waits on the first bench plan', () => {
  const { db, root, seen: s, on } = ticket(BENCH)
  const job = internalPlan(db, root, on + 1)
  s.open.push({ number: 901, title: BENCH, body: 'body', url: plan(db, on).origin ?? '' })
  ticketed(db, root, plan(db, job), 'run_pair loses its seed (lane:bench)', 'body', 'why', wire(s), now)
  expect(s.filed).toHaveLength(1)
  expect(waitsOn(db, job)).toBe(on)
})

test('a landed ticket over the refused span sends the job back', () => {
  const { db, root } = world()
  const job = internalPlan(db, root, 5)
  refused(db, { plan: job, step: 3, fingerprint: 'f'.repeat(64), diff: null, span: 'sequencer/push.ts:420' })
  hold(db, root, job, 'stopped', now, null, now)
  const s = seen({ closed: [{ number: 2030, title: 'land keeps the close comment', body: 'Changes `sequencer/push.ts:410-430`.',
    url: LANDED, comments: [{ body: 'landed on main as 4cb0e875' }] }] })
  expect(ticketed(db, root, plan(db, job), 'the close comment is lost', 'body', 'why', wire(s), now)).toBe(LANDED)
  expect(s.filed).toEqual([])
  expect(maybe(root, job, 'ask.md')).toContain('#2030 landed this as 4cb0e875: build on top of 4cb0e875')
  expect(plan(db, job).state).toBe('queued')
  expect(ofKind(db, 'covered')).toMatchObject([{ outcome: 'pass', message: expect.stringMatching(/: landed as 4cb0e875$/) as string }])
})

const FIX = 'the close comment is lost'
const fixed = (no: number) => seen({ closed: [{ number: no, title: FIX, body: '', url: `https://github.com/${SELF}/issues/${String(no)}`,
  comments: [{ body: 'landed on main as d85569e3' }] }] })

test('a machine fix resumes a rubin plan once, then holds it', () => {
  const { db, root } = world()
  putPlan(db, { id: 2454, pipe_id: 1, target_id: null, template: 'pr_path', state: 'blocked_on_ceo', queued_at: '2026-09-18T00:00:00.000Z',
    step: 6, retries: 0, lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/rubin-alert-monitor/issues/26' })
  put(root, 2454, 'ask.md', '# rubin\n')
  put(root, 2454, 'issue.md', '# rubin\n')
  const stop = () => ticketed(db, root, plan(db, 2454), FIX, 'body', 'why', wire(fixed(2094)), now)
  expect(stop()).toBe(`https://github.com/${SELF}/issues/2094`)
  expect(eventsOf(db, 2454, 'resume')).toMatchObject([{ message: `#2094 landed the fix for this stop as d85569e3 on ${SELF}` }])
  expect(eventsOf(db, 2454, 'return')).toMatchObject([{ message: 'step 6' }])
  expect([maybe(root, 2454, 'ask.md'), maybe(root, 2454, 'issue.md')]).toEqual(['# rubin\n', '# rubin\n'])
  hold(db, root, 2454, 'stopped', now, null, now)
  expect(stop()).toBe(false)
  expect(plan(db, 2454).state).toBe('blocked_on_ceo')
  expect(holdOf(db, 2454)).toMatchObject({ held_by: 'coo', held_why: expect.stringMatching(/^repeat: /) as string })
  expect(eventsOf(db, 2454, 'resume')).toHaveLength(1)
})

test('a built plan on its own repo gets the landed answer once', () => {
  const { db, root } = world()
  const job = internalPlan(db, root, 5)
  addRule(db, { id: 'typescript_specialist', kind: 'roster', path: 'seats/typescript_specialist', content_hash: '0'.repeat(64), loaded_at: '2026-09-25' })
  addRun(db, { plan: job, step: 2, seat: 'typescript_specialist', rule_hash: '0'.repeat(64), provider: 'claude-agent-sdk', model: 'm',
    effort: 'high', input_tokens: 1, cache_write_tokens: 0, cache_write_1h_tokens: null, cache_read_tokens: 0, output_tokens: 1, seconds: 1,
    exit: 0, at: now.toISOString(), transcript_path: 'r.transcript.jsonl', cost_usd: 0 })
  const stop = () => {
    hold(db, root, job, 'stopped', now, null, now)
    return ticketed(db, root, plan(db, job), FIX, 'body', 'why', wire(fixed(2094)), now)
  }
  expect(stop()).toBe(`https://github.com/${SELF}/issues/2094`)
  expect(plan(db, job).state).toBe('queued')
  expect(stop()).toBe(false)
  expect(maybe(root, job, 'issue.md')?.split('#2094 landed this as d85569e3').length).toBe(2)
  expect(holdOf(db, job)?.held_why).toMatch(/^repeat: #2094 landed this as d85569e3/)
})

test('an open ticket with a live plan holds the job on that plan', () => {
  const { db, root } = world()
  const on = internalPlan(db, root, 5, 'the floor', 2027)
  const s = seen({ open: [{ number: 2027, title: 'powered() applies the 8-agent floor', body: '', url: OPEN }] })
  expect(ticketed(db, root, plan(db, 1), '`powered()` drops the floor', 'body', 'four agents ran\nmore', wire(s), now)).toBe(OPEN)
  expect(s.filed).toEqual([])
  expect(waitsOn(db, 1)).toBe(on)
  expect(s.amended).toEqual(['#2027 - Also hit on plan 1: four agents ran'])
  expect(ofKind(db, 'covered')).toMatchObject([{ outcome: 'pass', message: expect.stringMatching(/: covered by #2027$/) as string }])
})

const RESEARCH = 'research answers skip the ruling'

test('a registry line with no Replaces: line is not filed', () => {
  const { db, filed, origin } = ticket(RESEARCH, 'Moves research_question_ruled.')
  expect(origin).toBe(false)
  expect(filed).toEqual([])
  expect(plan(db, 1).state).toBe('queued')
  expect(ofKind(db, 'covered')).toMatchObject([{ outcome: 'refuse',
    message: expect.stringMatching(/: not filed: names registry line research_question_ruled with no Replaces: line$/) as string }])
})

test('a registry line with a Replaces: line files', () => {
  expect(ticket(RESEARCH, 'Moves research_question_ruled.\n\nReplaces: nothing (checked)').filed).toHaveLength(1)
})
