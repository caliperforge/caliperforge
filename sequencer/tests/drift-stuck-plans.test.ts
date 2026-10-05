import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Db } from '../../store/index.ts'
import { take } from '../../store/leases.ts'
import { drift, stuck } from '../drift.ts'
import { conflicted, git, maybe } from '../workspace.ts'
import { COO, db, event, NOW } from './drifting.ts'

const STUCK = [{ name: 'stuck_plans', gap: '1h' }]
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000)

function stalling(): { d: Db; root: string } {
  const d = db()
  d.exec(`UPDATE plans SET state = 'running', step = 3, wait_reason = 'lane_over_cap';
    UPDATE pipes SET window_start = '00:00', window_end = '23:59'`)
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

test('stuckClosed', () => {
  for (const pipe of ['enabled = 0', "window_start = '23:00', window_end = '23:01'"]) {
    const { d, root } = stalling()
    d.exec(`UPDATE pipes SET ${pipe}`)
    for (const minutes of [0, 30, 61, 120]) expect(stuck(d, root, STUCK, at(minutes))).toEqual([])
  }
})

test('stuckOff', () => {
  const { d, root } = stalling()
  expect(drift(d, STUCK, NOW)).toEqual([])
  expect(stuck(d, root, [COO], NOW)).toEqual([])
  expect(maybe(root, 1, 'stuck.json')).toBeNull()
})
