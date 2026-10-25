import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Fired, Packet, Provider } from '../../providers/kind.ts'
import { gates } from '../../store/approvals.ts'
import { appliedOf } from '../../store/decisions.ts'
import { pushedRow } from '../../store/deliverables.ts'
import { addSetting } from '../../store/drift.ts'
import { ofKind, pointers } from '../../store/events.ts'
import { filesOf, record, recorded, strays } from '../../store/files.ts'
import { migrate, open } from '../../store/index.ts'
import { amend } from '../../store/lanes.ts'
import { clearedOf } from '../../store/refusals.ts'
import { runTokens } from '../../store/runs.ts'
import type { Wire } from '../push.ts'
import { allPlans, end, planById, planRows, putPlan, terminal, type PlanRow } from '../../store/plans.ts'
import { lapsed } from '../../store/until.ts'
import { woke } from '../director.ts'
import { CARRY, checkout, drop, get, git, maybe, put, SELF, srcDir } from '../workspace.ts'

const repo = join(import.meta.dirname, '../..')
const now = new Date('2026-09-25T17:00:00.000Z')
const FIX = '---\nmove: fix\nwhy: the brief names a migration number another job took\n---\n'

function seeded(mode: string) {
  const db = open(':memory:')
  migrate(db, join(repo, 'schema'))
  db.exec(readFileSync(join(repo, 'runner/tests/fixtures/waiting.sql'), 'utf8'))
  db.exec("UPDATE plans SET state = 'blocked_on_ceo', wait_reason = NULL WHERE id = 7")
  db.exec("UPDATE refusals SET at = '2026-09-25 16:00:00' WHERE plan = 7")
  addSetting(db, { key: 'director.apply', value: '1', who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-25' })
  addSetting(db, { key: 'fixer.mode', value: mode, who: 'ceo', origin_kind: 'ruling', origin_ref: 't', set_at: '2026-09-25' })
  const home = mkdtempSync(join(tmpdir(), 'cf-fx-'))
  for (const dir of ['rules', 'seats']) cpSync(join(repo, dir), join(home, dir), { recursive: true })
  put(home, 7, 'ask.md', 'the ask\n')
  put(home, 7, 'refusal.md', 'step 3 rails refused\n\nidentifiers: schema/0036_x.sql names no source\n')
  put(home, 7, 'step-4.verdict.md', '---\noutcome: refuse\nspans:\n  - x\n---\n')
  put(home, 7, 'base.sha', `${'a'.repeat(40)}\n`)
  writeFileSync(join(srcDir(home, 7), 'index.ts'), 'export {}\n')
  git(srcDir(home, 7), ['init', '-q', '-b', 'main'])
  git(srcDir(home, 7), ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', 'commit', '-q', '--allow-empty', '-m', 'built'])
  return { db, home }
}

function stub(fix: string, packets: Packet[], seated: Fired['ended'] = 'completed'): Provider {
  return {
    name: 'claude-agent-sdk',
    fire: (packet) => {
      packets.push(packet)
      const name = basename(packet.transcript)
      const text = name.startsWith('fixer') ? fix : FIX
      return Promise.resolve({ text, transcript_path: packet.transcript, usage: { input: 10, cache: 0, output: 5 },
        seconds: 0, ended: name.startsWith('fix-') ? seated : 'completed', exit: 0, stop_reason: 'end_turn', denials: 0 })
    },
  }
}

function wire(filed: string[]): Wire {
  const no = (): never => { throw new Error('not in this test') }
  return { send: no, open: no, close: no, runs: no, comment: no, review: no, merged: no,
    file: (...args) => { const title = args[1]; filed.push(title); return 'https://github.com/caliperforge/caliperforge/issues/999' } }
}

const state = (db: ReturnType<typeof open>) => (({ state, step }: PlanRow) => ({ state, step }))(planById(db, 7))
const applied = (db: ReturnType<typeof open>) => appliedOf(db, 7).map((applied) => ({ applied }))
const runs = (db: ReturnType<typeof open>) => runTokens(db, 7).filter((r) => ['fixer', 'director', 'swift_specialist'].includes(r.seat))
  .map(({ id, transcript_path, ...r }) => ({ ...r, named: Number(transcript_path.endsWith(`/run-${String(id)}.transcript.jsonl`)) }))
const RAN = [{ seat: 'director', input_tokens: 10, cache_read_tokens: 0, output_tokens: 5, named: 1, mode: null },
  { seat: 'fixer', input_tokens: 10, cache_read_tokens: 0, output_tokens: 5, named: 1, mode: null }]

const RETURN = '---\ndid: renamed schema/0036_x.sql to 0040_x.sql in src and issue.md\nthen: return\nwhy: the rails will find the file now\nadd_files: [schema/0040_x.sql]\n---\n'

test('live: the fixer fixes an ask_coo stop; nobody is pinged', async () => {
  const { db, home } = seeded('live')
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(applied(db)).toEqual([{ applied: 'applied' }])
  expect(posted).toEqual([])
  expect(recorded(db, 7)).toEqual(['schema/0040_x.sql'])
  const fixerPacket = packets.find((p) => basename(p.transcript).startsWith('fixer'))
  expect(fixerPacket?.tools).toContain('Edit')
  expect(fixerPacket?.prompt).toContain('# The machine\'s store')
  expect(runs(db)).toEqual(RAN)
  expect(ofKind(db, 'fixer')).toMatchObject([{ plan: 7, actor: 'fixer', outcome: 'pass', message: 'return: the rails will find the file now' }])
})

const UP = [{ actor: 'fixer', outcome: 'needs_coo' }]

test('shadow: the fixer only reads, the stop reaches a person', async () => {
  const { db, home } = seeded('shadow')
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(posted).toHaveLength(1)
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"mode":"shadow"')
  expect(runs(db)).toEqual([...RAN, ...RAN])
  expect(ofKind(db, 'fixer')).toEqual([])
})

const TICKET = '---\ndid: nothing\nthen: ticket\nwhy: the spend wall counts a turn four times\nticket: the run wall counts each streamed block\n---\n'
const pushed = (db: ReturnType<typeof open>, plan: number) => {
  pushedRow(db, { plan, step: 6, seat: 'typescript_specialist', diff_digest: 'd'.repeat(64),
    evidence: 'https://github.com/caliperforge/caliperforge/pull/1' }, gates(db, plan, 'd'.repeat(64)))
}
const ticketed = (db: ReturnType<typeof open>) => allPlans(db).find((p) => p.origin === 'https://github.com/caliperforge/caliperforge/issues/999')

test('ticket: filed, queued at P0, job held on it, checkout kept', async () => {
  const { db, home } = seeded('live')
  const filed: string[] = []
  const labels: string[][] = []
  const inner = wire(filed)
  const labelled: Wire = { ...inner, file: (...a: Parameters<typeof inner.file>) => { labels.push(a[3]); return inner.file(...a) } }
  await woke(db, home, stub(TICKET, []), now, () => undefined, labelled)
  expect(filed).toEqual(['the run wall counts each streamed block'])
  expect(labels).toEqual([['lane:machine', 'P0', 'fix']])
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(maybe(home, 7, 'parked.md')).toMatch(/^# Held .*\n\nhttps:\/\/github\.com\/caliperforge\/caliperforge\/issues\/999\n\nthe spend wall/)
  expect(terminal(db)).not.toContain(7)
  const on = ticketed(db)
  expect(on).toMatchObject({ priority: 0, lane: 'machine', state: 'queued' })
  expect(waitsOn(db)).toEqual({ waits_on: on?.id })
  expect(maybe(home, on?.id ?? 0, 'ask.md')).toContain('plan 7')
  expect(maybe(home, on?.id ?? 0, 'ask.md')).toContain('identifiers: schema/0036_x.sql')
  expect(ofKind(db, 'ticket').map((e) => e.actor)).toEqual(['fixer'])
  expect(pointers(db, 'ticket')).toEqual(['https://github.com/caliperforge/caliperforge/issues/999'])
})

test('ticket: the job is back at its step when the ticket lands', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub(TICKET, []), now, (t) => void posted.push(t), wire([]))
  end(db, ticketed(db)?.id ?? 0, 'done')
  pushed(db, ticketed(db)?.id ?? 0)
  await woke(db, home, stub(TICKET, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(posted).toEqual([])
})

test.each([
  { was: 'running', want: [], on: 8 },
  { was: 'done', want: ['the run wall counts each streamed block'], on: null },
] as const)('ticket: plan 8 $was with the same title files $want', async ({ was, want, on }) => {
  const { db, home } = seeded('live')
  second(db, was)
  put(home, 8, 'ask.md', '# the run wall counts each streamed block\n')
  const filed: string[] = []
  await woke(db, home, stub(TICKET, []), now, () => undefined, wire(filed))
  expect(filed).toEqual(want)
  expect(waitsOn(db)).toEqual({ waits_on: on ?? ticketed(db)?.id })
})

test('ask_ceo from the fixer reaches the phone with its reason', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: ask_ceo\nwhy: this changes what surfpool\'s maintainer sees\n---\n', []),
    now, (t) => void posted.push(t), wire([]))
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(applied(db)).toEqual([{ applied: 'escalated' }])
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(ofKind(db, 'fixer')).toMatchObject(UP)
})

test('two live fixes a day, then stops escalate without the fixer', async () => {
  const { db, home } = seeded('live')
  const at = new Date(now.getTime() - 60_000).toISOString()
  const line = JSON.stringify({ at, mode: 'live', did: 'x', then: 'return', why: 'y', tokens: 1, applied: 'return' })
  put(home, 7, 'fixes.jsonl', `${line}\n${line}\n`)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(false)
  expect(posted).toHaveLength(1)
  expect(ofKind(db, 'fixer')).toEqual([])
})

test('listing a built stray clears its flag, adding no second row', async () => {
  const { db, home } = seeded('live')
  record(db, 7, [{ path: 'a.ts', is_new: false }])
  strays(db, 7, ['schema/0040_x.sql'])
  await woke(db, home, stub(RETURN, []), now, () => undefined, wire([]))
  expect(recorded(db, 7)).toEqual(['a.ts', 'schema/0040_x.sql'])
  expect(filesOf(db, 7).map((f) => f.path)).toEqual(['a.ts', 'schema/0040_x.sql'])
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
})

test('a throwing fixer: the tick goes on, a person gets the stop', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  const broken: Wire = { ...wire([]), file: () => { throw new Error('gh is down') } }
  const count = () => planRows(db).length
  const was = count()
  await woke(db, home, stub('---\ndid: nothing\nthen: ticket\nwhy: a bug\nticket: a bug\n---\n', []), now, (t) => void posted.push(t), broken)
  expect(maybe(home, 7, 'fixer.error')).toBe('gh is down')
  expect(ofKind(db, 'fixer_error').map((e) => e.outcome)).toEqual(['escalate', 'escalate'])
  expect(posted).toHaveLength(1)
  expect(count()).toEqual(was)
  expect(waitsOn(db)).toEqual({ waits_on: null })
})

const WAIT = '---\ndid: answered in ask.md that it builds on plan 8\nthen: wait\nwhy: plan 8 has not landed\nwaits_on: 8\n---\n'

function second(db: ReturnType<typeof open>, state: PlanRow['state'] = 'running') {
  putPlan(db, { id: 8, pipe_id: 9, target_id: null, template: 'pr_path', state, queued_at: '2026-09-24', step: 2, retries: 0,
    lane: 'machine', seat: 'typescript_specialist', origin: 'https://github.com/caliperforge/caliperforge/issues/140' })
  amend(db, 8, { priority: 1 })
}

const waitsOn = (db: ReturnType<typeof open>) => ({ waits_on: planRows(db).find((r) => r.id === 7)?.waits_on })

test('gone checkout: rebuilt, no model', async () => {
  const { db, home } = seeded('live')
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  put(home, 7, 'base.merged', `${'b'.repeat(40)}\n`)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(RETURN, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 2 })
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(false)
  expect(posted).toEqual([])
  expect(maybe(home, 7, 'refusal.prev.md')).toContain('rails refused')
  expect(maybe(home, 7, 'refusal.md')).toBeNull()
  expect(maybe(home, 7, 'base.merged')).toBeNull()
  expect(maybe(home, 7, 'base.sha')).not.toBeNull()
  expect(clearedOf(db, 7)).toEqual([1])
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"rebuild"')
})

test('gone checkout, shadow: untouched', async () => {
  const { db, home } = seeded('shadow')
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  const posted: string[] = []
  await woke(db, home, stub(RETURN, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(posted).toHaveLength(1)
})

test('rebuild with a live checkout escalates', async () => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: rebuild\nwhy: x\n---\n', []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(existsSync(join(home, '.cf/work/7/src/index.ts'))).toBe(true)
  expect(posted).toHaveLength(1)
})

test('wait: held quietly, released on land', async () => {
  const { db, home } = seeded('live')
  second(db)
  const packets: Packet[] = []
  const posted: string[] = []
  await woke(db, home, stub(WAIT, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: 8 })
  expect(posted).toEqual([])
  expect(packets.find((p) => basename(p.transcript).startsWith('fixer'))?.prompt).toContain('- plan 8, running, step 2')
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  db.exec("UPDATE plans SET state = 'done' WHERE id = 8")
  pushed(db, 8)
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(maybe(home, 7, 'parked.md')).toBeNull()
  expect(posted).toEqual([])
})

test('wait on a refused job pings', async () => {
  const { db, home } = seeded('live')
  second(db)
  const posted: string[] = []
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  db.exec("UPDATE plans SET state = 'refused' WHERE id = 8")
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
})

const ISSUE = 'https://github.com/caliperforge/caliperforge/issues/140'

async function waitedOn(ended: PlanRow['state'], merged: Wire['merged']) {
  const { db, home } = seeded('live')
  second(db)
  const posted: string[] = []
  const asked: string[][] = []
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  db.exec(`UPDATE plans SET state = '${ended}' WHERE id = 8`)
  if (ended === 'done') pushed(db, 8)
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), { ...wire([]), merged: (args) => { asked.push(args); return merged(args) } })
  const row = planRows(db).find((r) => r.id === 7)
  return { db, posted, asked, held: { ...state(db), ...waitsOn(db), held_by: row?.held_by, held_why: row?.held_why } }
}

test.each(['refused', 'halted'] as const)('D1 wait on a %s job whose issue closed completed releases', async (ended) => {
  const { db, posted, asked, held } = await waitedOn(ended, () => ({ state: 'CLOSED', stateReason: 'COMPLETED' }))
  expect(held).toEqual({ state: 'queued', step: 4, waits_on: null, held_by: null, held_why: null })
  expect(posted).toEqual([])
  expect(asked).toEqual([['issue', 'view', '140', '--repo', 'caliperforge/caliperforge', '--json', 'state,stateReason']])
  expect(ofKind(db, 'waits_closed')).toEqual([{ plan: 7, kind: 'waits_closed', actor: 'fixer', outcome: 'pass',
    message: `plan 8 ended ${ended}, but ${ISSUE} is closed as completed, so this job is back in its lane` }])
  expect(pointers(db, 'waits_closed')).toEqual([ISSUE])
})

test.each([
  { said: 'open', merged: () => ({ state: 'OPEN', stateReason: null }) },
  { said: 'not planned', merged: () => ({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }) },
  { said: 'unreadable', merged: () => { throw new Error('gh is down') } },
])('D2 wait on a refused job, issue $said, stays with the COO', async ({ merged }) => {
  const { db, posted, held } = await waitedOn('refused', merged)
  const why = 'plan 8, which this job waits on, ended refused'
  expect(held).toEqual({ state: 'blocked_on_ceo', step: 4, waits_on: null, held_by: 'coo', held_why: why })
  expect(posted).toEqual(['CaliperForge · #139 needs you'])
  expect(ofKind(db, 'waits_closed')).toMatchObject([{ plan: 7, outcome: 'needs_coo', message: why }])
  expect(pointers(db, 'waits_closed')).toEqual([ISSUE])
})

test('D3 wait on a landed job reads no issue', async () => {
  const { db, asked, held } = await waitedOn('done', () => ({ state: 'CLOSED', stateReason: 'COMPLETED' }))
  expect(held).toMatchObject({ state: 'queued', step: 4, waits_on: null })
  expect(asked).toEqual([])
  expect(ofKind(db, 'waits_closed')).toEqual([])
})

test('wait on a closed job escalates', async () => {
  const { db, home } = seeded('live')
  second(db, 'done')
  const posted: string[] = []
  await woke(db, home, stub(WAIT, []), now, (t) => void posted.push(t), wire([]))
  expect(waitsOn(db)).toEqual({ waits_on: null })
  expect(posted).toHaveLength(1)
})

test('gone checkout, outside plan: to a person', async () => {
  const { db, home } = seeded('live')
  db.exec(`INSERT INTO accounts (id, repo, measured_at, maintainers, doors, last_outsider_merge, open_pr_age_p50_days,
    cross_repo_activity, pulse, evidence) VALUES (1, 'acme/kit', '2026-09-24', 2, 1, '2026-09-24', 3, 4, 'warm', 'https://github.com/acme/kit');
    INSERT INTO targets (id, account_id, repo, issue_no, named_merger, state, evidence_measured_at, evidence)
    VALUES (1, 1, 'acme/kit', 706, 'ludo', 'ready', '2026-09-24', 'https://github.com/acme/kit/issues/706')`)
  db.exec("UPDATE plans SET target_id = 1, lane = NULL, seat = NULL, origin = NULL WHERE id = 7")
  rmSync(join(home, '.cf/work/7/src'), { recursive: true })
  const packets: Packet[] = []
  await woke(db, home, stub('---\ndid: nothing\nthen: rebuild\nwhy: x\n---\n', packets), now, () => undefined, wire([]))
  expect(packets.some((p) => basename(p.transcript).startsWith('fixer'))).toBe(true)
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
})

test('park: held, not reaped, not re-woken', async () => {
  const { db, home } = seeded('live')
  const packets: Packet[] = []
  const posted: string[] = []
  const PARK = '---\ndid: nothing\nthen: park\nwhy: builds on a job not yet filed\nuntil: 2026-09-26T17:00:00.000Z\n---\n'
  await woke(db, home, stub(PARK, packets), now, (t) => void posted.push(t), wire([]))
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(posted).toEqual([])
  expect(lapsed(db, LATER)).toEqual([{ id: 7, step: 4, held_until: '2026-09-26T17:00:00.000Z' }])
  expect(maybe(home, 7, 'parked.md')).not.toBeNull()
  expect(terminal(db)).not.toContain(7)
  rmSync(join(home, '.cf/work/7/orchestrator.md'))
  await woke(db, home, stub(PARK, packets), now, () => undefined, wire([]))
  expect(packets.filter((p) => basename(p.transcript).startsWith('director'))).toHaveLength(1)
})

const LATER = '9999-12-31T00:00:00.000Z'

test.each(['', 'until: next week\n'])('park without a time it parses is unreadable: %j', async (until) => {
  const { db, home } = seeded('live')
  const posted: string[] = []
  await woke(db, home, stub(`---\ndid: nothing\nthen: park\nwhy: builds on a job not yet filed\n${until}---\n`, []),
    now, (t) => void posted.push(t), wire([]))
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"unreadable"')
  expect(ofKind(db, 'fixer')).toMatchObject([...UP, ...UP])
  expect(posted).toHaveLength(1)
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(lapsed(db, LATER)).toEqual([])
  expect(maybe(home, 7, 'parked.md')).toBe(null)
})

test('a # in did or why is kept whole', async () => {
  const { db, home } = seeded('live')
  const fix = '---\ndid: nothing; #37 landed at 22775be\nthen: ask_ceo\nwhy: #261: split of a split\n---\n'
  await woke(db, home, stub(fix, []), now, () => undefined, wire([]))
  const line = JSON.parse((maybe(home, 7, 'fixes.jsonl') ?? '').trim()) as { did: string; why: string }
  expect(line.did).toBe('nothing; #37 landed at 22775be')
  expect(line.why).toBe('#261: split of a split')
})

const SWIFT = 'step 3 rails refused by rails\n\nauthority\n\nspans:\n  - swift/Sources/x.swift:10\n'
const of = (packets: Packet[], tag: string) => packets.find((p) => basename(p.transcript).startsWith(tag))

function swift(mode: string, listed = true) {
  const s = seeded(mode)
  put(s.home, 7, 'refusal.md', SWIFT)
  if (listed) record(s.db, 7, [{ path: 'swift/Sources/x.swift', is_new: false }])
  return s
}

test('D1 a listed swift span goes to the swift seat in fix mode', async () => {
  const { db, home } = swift('live')
  const packets: Packet[] = []
  await woke(db, home, stub(RETURN, packets), now, () => undefined, wire([]))
  expect(runs(db)).toEqual([...RAN, { seat: 'swift_specialist', input_tokens: 10, cache_read_tokens: 0, output_tokens: 5, named: 1, mode: 'fix' }])
  expect(of(packets, 'fix-')?.cwd).toBe(srcDir(home, 7))
  expect(of(packets, 'fixer')?.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
})

test.each([false, true])('D2 an unlisted swift span stays with the fixer: stray %s', async (stray) => {
  const { db, home } = swift('live', false)
  if (stray) strays(db, 7, ['swift/Sources/x.swift'])
  const packets: Packet[] = []
  await woke(db, home, stub(RETURN, packets), now, () => undefined, wire([]))
  expect(of(packets, 'fix-')).toBeUndefined()
  expect(of(packets, 'fixer')?.tools).toContain('Edit')
})

test('D3 shadow fires no language seat', async () => {
  const { db, home } = swift('shadow')
  const packets: Packet[] = []
  await woke(db, home, stub(RETURN, packets), now, () => undefined, wire([]))
  expect(of(packets, 'fixer')).toBeDefined()
  expect(of(packets, 'fix-')).toBeUndefined()
})

test('D4 a stopped seat run is unrepaired and reaches a person', async () => {
  const { db, home } = swift('live')
  const posted: string[] = []
  await woke(db, home, stub(RETURN, [], 'stopped'), now, (t) => void posted.push(t), wire([]))
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"unrepaired"')
  expect(ofKind(db, 'fixer')).toMatchObject([...UP, ...UP])
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(posted).toHaveLength(1)
})

const DONE = '---\ndid: nothing\nthen: done\nwhy: the pull request is up\n---\n'

test.each([
  { shipped: false, want: 'escalated', ends: 'blocked_on_ceo' },
  { shipped: true, want: 'applied', ends: 'done' },
] as const)('done with pushed $shipped ends $ends', async ({ shipped, want, ends }) => {
  const { db, home } = seeded('live')
  if (shipped) pushed(db, 7)
  await woke(db, home, stub(DONE, []), now, () => undefined, wire([]))
  expect(applied(db)).toEqual([{ applied: want }])
  expect(state(db)).toEqual({ state: ends, step: 4 })
})

const MEASURED = '---\ndid: added the **Measure:** and **Output:** lines to ask.md\nthen: return\nwhy: gather can run the fetcher now\n---\n'

test('D1 research: the fixer adds the missing ask lines', async () => {
  const { db, home } = seeded('live')
  db.exec("UPDATE plans SET template = 'research', step = 1 WHERE id = 7")
  put(home, 7, 'ask.md', '# rates\n\n**Question:** what is the p50 rate?\n')
  put(home, 7, 'refusal.md', 'ask needs executed runs: add a **Measure:** line so the measurer gathers it\n')
  const inner = stub(MEASURED, [])
  const edits: Provider = { ...inner, fire: (packet) => {
    if (basename(packet.transcript).startsWith('fixer') && packet.refuse('ask.md') === null) {
      appendFileSync(join(packet.cwd, 'ask.md'), '**Measure:** run the rate probe\n**Output:** ~/cf_work/rates/\n')
    }
    return inner.fire(packet)
  } }
  await woke(db, home, edits, now, () => undefined, wire([]))
  expect(maybe(home, 7, 'ask.md')).toMatch(/\*\*Measure:\*\* .*\n\*\*Output:\*\* ~\/cf_work\/rates\/\n$/)
  expect(state(db)).toEqual({ state: 'queued', step: 1 })
  expect(applied(db)).toEqual([{ applied: 'applied' }])
  expect(maybe(home, 7, 'refusal.prev.md')).toContain('**Measure:**')
  expect(maybe(home, 7, 'refusal.md')).toBeNull()
})

const EDIT = 'export const edited = true'


function branched() {
  const s = seeded('live')
  const base = mkdtempSync(join(tmpdir(), 'cf-fx-base-'))
  const remote = join(base, SELF)
  mkdirSync(remote, { recursive: true })
  const commit = (file: string, body: string) => {
    writeFileSync(join(remote, file), body)
    git(remote, ['add', '-A'])
    git(remote, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file])
    return git(remote, ['rev-parse', 'HEAD']).trim()
  }
  git(remote, ['init', '-q', '-b', 'main'])
  const first = commit('index.ts', 'export {}\n')
  commit('index.ts', 'export const main = 1\n')
  git(remote, ['checkout', '-q', '-b', 'redesign'])
  const tip = commit('redesign.ts', 'export const redesign = 1\n')
  git(remote, ['checkout', '-q', 'main'])
  writeFileSync(join(s.home, '.cf/git-base'), base)
  rmSync(srcDir(s.home, 7), { recursive: true })
  drop(s.home, 7, 'base.sha')
  const { base: cut } = checkout(s.home, 7, SELF, 'p7-fix')
  appendFileSync(join(srcDir(s.home, 7), 'index.ts'), `${EDIT}\n`)
  return { ...s, first, tip, cut }
}

const CUT_TO = '---\ndid: set the cut\nthen: return\nwhy: the checks judge the right base now\n---\n'

function edits(write: (cwd: string) => void): Provider {
  const inner = stub(CUT_TO, [])
  return { ...inner, fire: (packet) => {
    if (basename(packet.transcript).startsWith('fixer')) write(packet.cwd)
    return inner.fire(packet)
  } }
}

test('D1 a base.sha HEAD contains is applied', async () => {
  const { db, home, first } = branched()
  await woke(db, home, edits((cwd) => { writeFileSync(join(cwd, 'base.sha'), `${first}\n`) }), now, () => undefined, wire([]))
  expect(state(db)).toEqual({ state: 'queued', step: 4 })
  expect(get(home, 7, 'base.sha').trim()).toBe(first)
  expect(applied(db)).toEqual([{ applied: 'applied' }])
})

test('D2 a base.sha HEAD does not contain is refused and put back', async () => {
  const { db, home, tip, cut } = branched()
  const posted: string[] = []
  await woke(db, home, edits((cwd) => { writeFileSync(join(cwd, 'base.sha'), `${tip}\n`) }), now, (t) => void posted.push(t), wire([]))
  expect(get(home, 7, 'base.sha').trim()).toBe(cut)
  expect(state(db)).toEqual({ state: 'blocked_on_ceo', step: 4 })
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"refused"')
  expect(ofKind(db, 'fixer')[0]).toMatchObject({ outcome: 'needs_coo', message: 'refused: a cut moves only through a Base: line in ask.md' })
  expect(applied(db)).not.toContainEqual({ applied: 'applied' })
  expect(posted).toHaveLength(1)
})

test('D3 a Base: line recuts and carries only the plan diff', async () => {
  const { db, home, cut } = branched()
  await woke(db, home, edits((cwd) => { appendFileSync(join(cwd, 'ask.md'), 'Base: redesign\n') }), now, () => undefined, wire([]))
  expect(applied(db)).toEqual([{ applied: 'applied' }])
  expect(maybe(home, 7, 'fixes.jsonl')).toContain('"applied":"return"')
  expect(get(home, 7, 'base.sha').trim()).toBe(cut)
  expect(checkout(home, 7, SELF, 'p7-fix', 'redesign').recut).toBe('main')
  expect(get(home, 7, CARRY)).toContain(`+${EDIT}`)
  expect(get(home, 7, CARRY)).not.toContain('redesign.ts')
})

const OUT = join(homedir(), 'cf_work/fx-out')

async function outputFixer(template: string): Promise<Packet | undefined> {
  const { db, home } = seeded('live')
  db.exec(`UPDATE plans SET template = '${template}' WHERE id = 7`)
  put(home, 7, 'ask.md', '# x\n\n**Output:** ~/cf_work/fx-out/\n')
  const packets: Packet[] = []
  await woke(db, home, stub(RETURN, packets), now, () => undefined, wire([]))
  return of(packets, 'fixer')
}

const admits = (p: Packet | undefined, paths: string[]) => paths.map((f) => p?.refuse(f) === null)

test('D2 a research fixer writes its ask and its Output folder', async () => {
  const p = await outputFixer('research')
  expect(p?.reads).toEqual([OUT])
  expect(admits(p, ['ask.md', 'rulings.md', 'question.md', join(OUT, 'a.md')])).toEqual([true, true, true, true])
  expect(admits(p, ['src/index.ts', join(homedir(), 'cf_work/fx-other/a.md')])).toEqual([false, false])
})

test('D3 a pr_path fixer refuses an Output folder', async () => {
  const p = await outputFixer('pr_path')
  expect(p?.reads).toBeUndefined()
  expect(admits(p, ['ask.md', join(OUT, 'a.md')])).toEqual([true, false])
})

test('the packet lists the other open jobs and the store', async () => {
  const { db, home } = seeded('live')
  second(db)
  const packets: Packet[] = []
  await woke(db, home, stub(RETURN, packets), now, () => undefined, wire([]))
  const prompt = of(packets, 'fixer')?.prompt ?? ''
  expect(prompt).toMatch(/# Open jobs\n\n- plan 8, /)
  expect(prompt).not.toContain('- plan 7,')
  expect(prompt).toMatch(/CREATE TABLE "plans" \([\s\S]*?\);\n/)
})
