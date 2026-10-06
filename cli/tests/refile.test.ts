import { expect, test, vi } from 'vitest'
import { internalPlan, world } from '../../sequencer/tests/world.ts'
import { SELF } from '../../sequencer/workspace.ts'
import { logged } from '../../store/events.ts'
import type { Db } from '../../store/index.ts'
import type { Read, Run } from '../gh.ts'
import { refile } from '../refile.ts'

const TO = 'caliperforge/atelier'
const URL = `https://github.com/${TO}/issues/5`
const read: Read = () => ({ title: 'the old title' })

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
    [['issue', 'create', '--repo', TO, '--title', 'the old title', '--body-file', '-'], 'newer block'],
    [['issue', 'close', '7', '--repo', SELF, '--comment', `Moved to ${URL}`], undefined],
  ])
})

test('D2 refile refuses a plan with no coo_lite event', () => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  const exec = vi.fn<Run>()
  expect(() => refile(w.db, `${SELF}#7`, TO, read, exec)).toThrow('has no coo_lite event')
  expect(exec).not.toHaveBeenCalled()
})

test.each([
  [`${SELF}#8`, TO, "no plan's origin"],
  [SELF, TO, 'takes <owner/name#n>'],
  [`${SELF}#7`, 'atelier', 'takes <owner/name#n>'],
])('D3 D4 refile refuses %s %s untouched', (from, to, refusal) => {
  const w = world()
  internalPlan(w.db, w.root, 2, 'misfiled', 7)
  said(w.db, 2, 'block')
  const looked = vi.fn<Read>()
  const exec = vi.fn<Run>()
  expect(() => refile(w.db, from, to, looked, exec)).toThrow(refusal)
  expect(looked).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
})
