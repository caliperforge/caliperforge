import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { all } from '../../cli/inbox.ts'
import type { Provider } from '../../providers/kind.ts'
import { stalled } from '../../store/drift.ts'
import { eventsOf, logged, ofKind } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { record as observe, set } from '../../store/lanes.ts'
import { take } from '../../store/leases.ts'
import { woke } from '../director.ts'
import { drift, type Drifted, stuck } from '../drift.ts'
import { HELD } from '../settle.ts'
import { conflicted, drop, git, maybe, put, snapshot } from '../workspace.ts'
import { COO, db, event, NOW, REGISTRY } from './drifting.ts'

const STUCK = [{ name: 'stuck_plans', gap: '1h' }]
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)

function stalling(): { d: Db; root: string } {
  const d = db()
  d.exec(`UPDATE plans SET state = 'running', step = 3, wait_reason = 'lane_over_cap';
    UPDATE pipes SET window_start = '00:00', window_end = '23:59'`)
  const root = mkdtempSync(join(tmpdir(), 'stuck-'))
  put(root, 1, 'issue.md', '# t\n')
  return { d, root }
}

test('stuckNoIssueRewinds', () => {
  const { d, root } = stalling()
  drop(root, 1, 'issue.md')
  d.exec('UPDATE plans SET step = 6, retries = 1')
  expect(stuck(d, root, STUCK, at(0))).toEqual([])
  expect(d.prepare('SELECT step, retries, state FROM plans WHERE id = 1').get()).toEqual({ step: 1, retries: 0, state: 'running' })
  expect(d.prepare("SELECT actor, outcome, message FROM events WHERE kind = 'stuck'").all())
    .toEqual([{ actor: 'drift', outcome: 'pass', message: 'step 6 has no issue.md to work from; back to the brief' }])
  expect(maybe(root, 1, 'stuck.json')).toBeNull()
})

test('stuckNoIssueRefused', () => {
  for (const plan of ['step = 1', "template = 'comms'", 'lease']) {
    const { d, root } = stalling()
    drop(root, 1, 'issue.md')
    if (plan === 'lease') take(d, 1, at(0))
    else d.exec(`UPDATE plans SET ${plan}`)
    expect(stuck(d, root, STUCK, at(0))).toEqual([])
    expect(d.prepare('SELECT step FROM plans WHERE id = 1').get()).toEqual({ step: plan === 'step = 1' ? 1 : 3 })
    expect(ofKind(d, 'stuck')).toEqual([])
  }
})

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
  expect(d.prepare("SELECT actor, outcome FROM events WHERE kind = 'stuck'").all()).toEqual([{ actor: 'drift', outcome: 'escalate' }])
  expect(stuck(d, root, STUCK, at(62))).toEqual([])
})

const reading = (d: Db, utilization: number, resets: number, observed = new Date()): void => {
  observe(d, { observed_at: observed.toISOString(), rate_limit_type: 'seven_day', resets_at: resets / 1000, status: 'allowed_warning', utilization })
}

test('stuckThrottledSkips', () => {
  const { d, root } = stalling()
  const resets = Math.floor(Date.now() / 1000) * 1000 + 86_400_000
  reading(d, 0.96, resets, new Date(Date.now() - 7 * 3_600_000))
  for (const minutes of [0, 61, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(ofKind(d, 'stuck')).toEqual([])
  expect(d.prepare('SELECT state FROM plans WHERE id = 1').get()).toEqual({ state: 'running' })
  expect(maybe(root, 1, 'stuck.json')).toBeNull()
  const first = new Date(resets).toISOString()
  expect(all(root)).toMatchObject([{ kind: 'throttled', ticket: `usage resets ${first}`,
    note: `lane cap 0 at seven_day utilisation 0.96; stuck and the director leave lane_over_cap plans until ${first}` }])
  reading(d, 0.97, resets + 86_400_000)
  expect(stuck(d, root, STUCK, at(180))).toEqual([])
  expect(all(root).map((e) => e.ticket)).toEqual([`usage resets ${first}`, `usage resets ${new Date(resets + 86_400_000).toISOString()}`])
})

test('wokeThrottledLeavesLaneOverCap', async () => {
  const { d, root } = stalling()
  for (const minutes of [0, 30]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(stuck(d, root, STUCK, at(61))).toEqual([1])
  reading(d, 0.96, Date.now() + 86_400_000)
  const provider: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('fired') } }
  await woke(d, root, provider, at(90), () => undefined)
  expect(eventsOf(d, 1, 'director')).toEqual([])
})

test('throttleNoStuckSeen', () => {
  const entry = REGISTRY.filter((e) => e.name === 'throttle_no_stuck')
  const seen = (utilization: number, at: string): Drifted[] => {
    const d = db()
    reading(d, utilization, Date.parse('2026-10-03T00:00:00Z'), new Date('2026-10-02T08:00:00Z'))
    logged(d, { plan: 1, kind: 'stuck', actor: 'drift', outcome: 'escalate', message: 'step 3 unchanged; waits: lane_over_cap; last: m',
      pointer: null, run: null }, at)
    return drift(d, entry, NOW)
  }
  expect(seen(0.96, '2026-10-02 09:00:00')).toMatchObject([{ name: 'throttle_no_stuck', state: 'seen', newest: '2026-10-02 09:00:00' }])
  expect(seen(0.96, '2026-10-02 15:00:00')).toMatchObject([{ name: 'throttle_no_stuck', state: 'seen' }])
  expect(seen(0.96, '2026-10-03 01:00:00')).toEqual([])
  expect(seen(0.9, '2026-10-02 09:00:00')).toEqual([])
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

test('stuckOverlap', () => {
  const { d, root } = stalling()
  d.exec(`INSERT INTO plans (pipe_id, template, state, queued_at, lane, seat, origin, step, priority)
    VALUES ((SELECT min(id) FROM pipes), 'pr_path', 'queued', '2026-10-01', 'machine', 'typescript_specialist', 'https://github.com/a/b/issues/2', 0, 3);
    UPDATE plans SET wait_reason = 'file_overlap', waits_on = 2 WHERE id = 1`)
  for (const minutes of [0, 30, 61, 90, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(d.prepare('SELECT state FROM plans WHERE id = 1').get()).toEqual({ state: 'running' })
  expect(maybe(root, 1, 'refusal.md')).toBeNull()
  expect(d.prepare("SELECT count(*) AS n FROM events WHERE kind = 'stuck'").get()).toEqual({ n: 0 })
})

test('stuckScoreBusy', () => {
  const { d, root } = stalling()
  d.exec("UPDATE plans SET template = 'bench', state = 'queued', step = 2, wait_reason = 'bench_score_busy' WHERE id = 1")
  for (const minutes of [0, 30, 61, 90, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(d.prepare('SELECT state FROM plans WHERE id = 1').get()).toEqual({ state: 'queued' })
  expect(maybe(root, 1, 'refusal.md')).toBeNull()
  expect(ofKind(d, 'stuck')).toEqual([])
  expect(stalled(d, [d.prepare('SELECT min(id) FROM pipes').pluck().get() as number])).toEqual([])
})

test('stuckNight', () => {
  const { d, root } = stalling()
  d.exec("UPDATE plans SET template = 'bench', state = 'queued', step = 2, wait_reason = 'bench_night' WHERE id = 1")
  for (const minutes of [0, 30, 61, 90, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(d.prepare('SELECT state FROM plans WHERE id = 1').get()).toEqual({ state: 'queued' })
  expect(maybe(root, 1, 'refusal.md')).toBeNull()
  expect(ofKind(d, 'stuck')).toEqual([])
  expect(stalled(d, [d.prepare('SELECT min(id) FROM pipes').pluck().get() as number])).toEqual([])
})

test('stuckOffline', () => {
  const { d, root } = stalling()
  logged(d, { plan: 1, kind: 'gather', actor: 'researcher', outcome: 'pass', message: `step 1 gather: ${HELD}`, pointer: null, run: null })
  for (const minutes of [0, 30, 61, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(d.prepare('SELECT state FROM plans WHERE id = 1').get()).toEqual({ state: 'running' })
  expect(ofKind(d, 'stuck')).toEqual([])
})

test('stuckClosed', () => {
  for (const pipe of ['enabled = 0', "window_start = '23:00', window_end = '23:01'"]) {
    const { d, root } = stalling()
    d.exec(`UPDATE pipes SET ${pipe}`)
    for (const minutes of [0, 30, 61, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  }
})

const WHY = 'threw once on a GitHub TLS handshake timeout, passes on the next run'

function returnedTwice(): { d: Db; root: string; src: string } {
  const { d, root } = stalling()
  const src = join(root, '.cf/work/1/src')
  mkdirSync(src, { recursive: true })
  git(src, ['init', '-q'])
  writeFileSync(join(src, 'a'), 'a')
  for (const start of [0, 100]) {
    for (const minutes of [0, 30]) expect(stuck(d, root, STUCK, at(start + minutes))).toEqual([])
    expect(stuck(d, root, STUCK, at(start + 61))).toEqual([1])
    logged(d, { plan: 1, kind: 'director', actor: 'director', outcome: 'pass', message: `return: ${WHY}`, pointer: null, run: null })
    d.exec("UPDATE plans SET state = 'running'")
  }
  return { d, root, src }
}

const stuckEvents = (d: Db) => d.prepare("SELECT outcome FROM events WHERE kind = 'stuck'").pluck().all()

test('stuckReturnedTwiceHoldsForCoo', async () => {
  const { d, root, src } = returnedTwice()
  for (const minutes of [200, 230]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(stuck(d, root, STUCK, at(261))).toEqual([1])
  const tree = snapshot(src)
  expect(d.prepare('SELECT state, held_by, held_why FROM plans WHERE id = 1').get()).toEqual({ state: 'blocked_on_ceo', held_by: 'coo',
    held_why: `the director returned step 3 on tree ${tree} 2 times; last reason: ${WHY}; ` +
      `step 3 and its tree unchanged for 61 min while the tick ran; waits: lane_over_cap; last: return: ${WHY}` })
  expect(stuckEvents(d)).toEqual(['escalate', 'escalate', 'needs_coo'])
  const provider: Provider = { name: 'claude-agent-sdk', fire: () => { throw new Error('fired') } }
  await woke(d, root, provider, at(300), () => undefined)
  expect(eventsOf(d, 1, 'director')).toHaveLength(2)
})

test('stuckNewTreeEscalates', () => {
  const { d, root, src } = returnedTwice()
  writeFileSync(join(src, 'b'), 'b')
  for (const minutes of [200, 230]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(stuck(d, root, STUCK, at(261))).toEqual([1])
  expect(d.prepare('SELECT held_why FROM plans WHERE id = 1').pluck().get())
    .toBe(`step 3 and its tree unchanged for 61 min while the tick ran; waits: lane_over_cap; last: return: ${WHY}`)
  expect(stuckEvents(d)).toEqual(['escalate', 'escalate', 'escalate'])
})

test('directorRepeatReturnSeen', () => {
  const d = db()
  const entry = REGISTRY.filter((e) => e.name === 'director_repeat_return')
  expect(drift(d, entry, NOW)).toEqual([])
  logged(d, { plan: 1, kind: 'stuck', actor: 'drift', outcome: 'needs_coo', message: 'm', pointer: null, run: null }, '2026-10-03 09:00:00')
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'director_repeat_return', state: 'seen' }])
  d.exec("UPDATE settings SET value = '0' WHERE key = 'director.apply'")
  expect(drift(d, entry, NOW)).toMatchObject([{ name: 'director_repeat_return', state: 'off' }])
})

function longJob(pid: number, exited = false): { d: Db; root: string } {
  const { d, root } = stalling()
  d.exec("UPDATE plans SET wait_reason = 'long_job'")
  logged(d, { plan: 1, kind: 'long_job', actor: 'started', outcome: 'pass', message: 'sleep 30', pointer: null, run: null })
  const out = mkdtempSync(join(tmpdir(), 'job-'))
  if (exited) writeFileSync(join(out, 'job.exit'), '0\n')
  put(root, 1, 'job.json', JSON.stringify({ command: 'sleep 30', out, pid, at: at(0).toISOString() }))
  set(d, 'research.long_job_seconds', '7200', 'ceo', at(0).toISOString())
  return { d, root }
}

const gone = (): number => spawnSync('true').pid

test('stuckLongJobLive', () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    const { d, root } = longJob(child.pid ?? 0)
    for (const minutes of [0, 30, 61]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
    expect(JSON.parse(maybe(root, 1, 'stuck.json') ?? '{}')).toMatchObject({ since: at(0).toISOString() })
    expect(stuck(d, root, STUCK, at(121))).toEqual([1])
    expect(d.prepare('SELECT state, held_why FROM plans WHERE id = 1').get())
      .toMatchObject({ state: 'blocked_on_ceo', held_why: expect.stringContaining('waits: long_job; ') as string })
  } finally {
    child.kill('SIGKILL')
  }
})

test('stuckLongJobGone', () => {
  const { d, root } = longJob(gone())
  for (const minutes of [0, 30]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  expect(stuck(d, root, STUCK, at(61))).toEqual([1])
})

test('stuckLongJobExited', () => {
  const { d, root } = longJob(gone(), true)
  for (const minutes of [0, 30, 61]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
})

test('stuckOff', () => {
  const { d, root } = stalling()
  expect(drift(d, STUCK, NOW)).toEqual([])
  expect(stuck(d, root, [COO], NOW)).toEqual([])
  expect(maybe(root, 1, 'stuck.json')).toBeNull()
})
