import { expect, test, vi } from 'vitest'
import { tick } from '../index.ts'
import { diffOf, maybe, SELF } from '../workspace.ts'
import { logged, runRows } from '../../store/events.ts'
import { dropPlan } from '../../store/plans.ts'
import { CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const { gh, run } = vi.hoisted(() => ({ gh: vi.fn(), run: vi.fn() }))

vi.mock('../../cli/gh.ts', async (importOriginal) => ({ ...await importOriginal<object>(), gh, run }))

const ID = 2
const URL = 'https://github.com/caliperforge/atelier/issues/5'
const FENCE = (line: string): string => `---\noutcome: command\nrun: ${line}\n---\n`
const REFILE = `cf gh refile ${SELF}#7 caliperforge/atelier`

async function commanding(line: string): Promise<World> {
  gh.mockReset().mockReturnValue({ title: 'the old title' })
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID, 'misfiled', 7)
  logged(w.db, { plan: ID, kind: 'director', actor: 'coo_lite', outcome: 'needs_ceo', message: 'block', pointer: null, run: null })
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, ID))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, FENCE(line)), undefined, undefined, watched([], w.root, ID))
  return w
}

test('D1: a refile command ends the plan done at step 1', async () => {
  run.mockReset().mockReturnValue(`${URL}\n`)
  const w = await commanding(REFILE)
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  expect(runRows(w.db).filter((r) => r.plan === ID && r.step >= 2)).toHaveLength(0)
  expect(diffOf(w.root, ID)).toBe('')
  expect(maybe(w.root, ID, 'command.md')).toBe(`${REFILE}\n\n${URL}\n`)
  expect(maybe(w.root, ID, 'issue.md')).toBeNull()
})

test('D2: a refile that throws blocks the plan on the CEO', async () => {
  run.mockReset().mockImplementation(() => { throw new Error('gh exited 1') })
  const w = await commanding(REFILE)
  expect(plan(w.db, ID)).toMatchObject({ state: 'blocked_on_ceo' })
  expect(maybe(w.root, ID, 'command.md')).toBe(`${REFILE}\n\ngh exited 1\n`)
})

test('D3: a command off the allow-list is refused with no gh call', async () => {
  run.mockReset()
  const w = await commanding('cf gh close x#1')
  expect(plan(w.db, ID).state).not.toBe('done')
  expect(maybe(w.root, ID, 'refusal.md')).toContain('cf gh close x#1 is not on the allow-list')
  expect(gh).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
