import { expect, test, vi } from 'vitest'
import { released } from '../../sequencer/fixer.ts'
import { hold } from '../../sequencer/hold.ts'
import { internalPlan, world } from '../../sequencer/tests/world.ts'
import { SELF } from '../../sequencer/workspace.ts'
import { logged } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import { end, planRows, waiting } from '../../store/plans.ts'
import type { Read, Run } from '../gh.ts'
import { refile } from '../refile.ts'

const TO = 'caliperforge/atelier'
const BENCH = 'caliperforge/fuzz-bench'
const URL = `https://github.com/${TO}/issues/5`
const read: Read = () => ({ title: 'the old title', body: 'the old body', labels: [] })

function said(db: Db, plan: number, message: string): void {
  logged(db, { plan, kind: 'director', actor: 'coo_lite', outcome: 'needs_ceo', message, pointer: null, run: null })
}

test('D1 refile opens the newest block on to, closes the old', () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  said(w.db, 2, 'older block')
  said(w.db, 2, 'newer block')
  const calls: [string[], string | undefined][] = []
  const exec: Run = (args, input) => { calls.push([args, input]); return `${URL}\n` }
  expect(refile(w.db, `${SELF}#7`, TO, read, exec)).toBe(URL)
  expect(calls).toEqual([
    [['issue', 'create', '--repo', TO, '--title', 'the old title', '--body-file', '-'], 'the old body\n\n## Why it moved\n\nnewer block'],
    [['issue', 'close', '7', '--repo', SELF, '--comment', `Moved to ${URL}`], undefined],
  ])
})

test('D2 refile with no coo_lite event moves the source body', () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  const calls: [string[], string | undefined][] = []
  const exec: Run = (args, input) => { calls.push([args, input]); return `${URL}\n` }
  expect(refile(w.db, `${SELF}#7`, TO, read, exec)).toBe(URL)
  expect(calls).toEqual([
    [['issue', 'create', '--repo', TO, '--title', 'the old title', '--body-file', '-'], 'the old body'],
    [['issue', 'close', '7', '--repo', SELF, '--comment', `Moved to ${URL}`], undefined],
  ])
})

test('D2 refile carries the lane mapped to to, and the P label', () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  const labelled: Read = () => ({ title: 'the old title', body: 'the old body',
    labels: [{ name: 'lane:machine' }, { name: 'P1' }, { name: 'seat:x' }] })
  const filed = (to: string): string[][] => {
    const calls: string[][] = []
    refile(w.db, `${SELF}#7`, to, labelled, (args) => { calls.push(args); return `${URL}\n` })
    return calls
  }
  expect(filed(BENCH)).toEqual([
    ['label', 'create', 'lane:bench', '--repo', BENCH, '--force'],
    ['label', 'create', 'P1', '--repo', BENCH, '--force'],
    ['issue', 'create', '--repo', BENCH, '--title', 'the old title', '--body-file', '-', '--label', 'lane:bench', '--label', 'P1'],
    ['issue', 'close', '7', '--repo', SELF, '--comment', `Moved to ${URL}`],
  ])
  expect(filed(TO).at(-2)).toEqual(
    ['issue', 'create', '--repo', TO, '--title', 'the old title', '--body-file', '-', '--label', 'lane:machine', '--label', 'P1'])
})

test('D3 refile holds a waiting plan on the new url', () => {
  const w = world()
  const now = new Date()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  internalPlan(w.db, w.root, 3, 'waits on 2', 8)
  internalPlan(w.db, w.root, 4, 'waits on 3', 9)
  hold(w.db, w.root, 3, 'after 2', now, 2)
  hold(w.db, w.root, 4, 'after 3', now, 3)
  internalPlan(w.db, w.root, 5, 'overlaps 2', 10)
  waiting(w.db, [{ plan: 5, why: 'file_overlap', on: 2 }])
  refile(w.db, `${SELF}#7`, TO, read, () => `${URL}\n`)
  end(w.db, 2, 'done')
  released(w.db, w.root, now, vi.fn())
  const rows = planRows(w.db)
  expect(rows.find((r) => r.id === 3)).toMatchObject(
    { state: 'blocked_on_ceo', waits_on: null, held_by: 'coo', held_why: `waits on ${URL}` })
  expect(rows.find((r) => r.id === 4)).toMatchObject({ state: 'blocked_on_ceo', waits_on: 3, held_why: 'after 3' })
  expect(rows.find((r) => r.id === 5)).toMatchObject({ held_by: null, held_why: null })
})

test.each([
  [{ title: 'the old title', labels: [] }],
  [{ title: 'the old title', body: 'the old body' }],
])('D4 refile refuses a gh reply missing a field', (reply) => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  const exec = vi.fn<Run>()
  expect(() => refile(w.db, `${SELF}#7`, TO, () => reply, exec)).toThrow()
  expect(exec).not.toHaveBeenCalled()
})

test.each([
  [`${SELF}#8`, TO, "no plan's origin"],
  [SELF, TO, 'takes <owner/name#n>'],
  [`${SELF}#7`, 'atelier', 'takes <owner/name#n>'],
])('D3 refile refuses %s %s untouched', (from, to, refusal) => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  said(w.db, 2, 'block')
  const looked = vi.fn<Read>()
  const exec = vi.fn<Run>()
  expect(() => refile(w.db, from, to, looked, exec)).toThrow(refusal)
  expect(looked).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
})
