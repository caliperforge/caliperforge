import { expect, test } from 'vitest'
import { record as recordFiles } from '../../store/files.ts'
import { amend, dial, set, width } from '../../store/lanes.ts'
import { held, holder, take } from '../../store/leases.ts'
import { addPipe, pipeNamed, planRows, putPlan, WAIT, type PlanRow } from '../../store/plans.ts'
import { at } from '../../templates/pr-path.ts'
import { route, type Route } from '../next.ts'
import { mapOf } from '../steps.ts'
import { approve, plan, world, type World } from './world.ts'

const NOW = new Date()

interface Row {
  state: () => World
  id?: number
  mine?: boolean
  want: Route
}

const stepTo = (w: World, id: number, step: number): World => {
  amend(w.db, id, { step, state: 'running' })
  return w
}

const another = (w: World, id: number, pipe: number, step: number, state: PlanRow['state'] = 'running'): World => {
  putPlan(w.db, { id, pipe_id: pipe, target_id: 1, template: 'pr_path', state, queued_at: '2026-09-18T00:00:00.000Z', step, retries: 0 })
  return w
}

const behind = (step: number) => (): World => {
  const w = stepTo(world(), 1, step)
  width(w.db, 1, 1)
  return another(w, 2, 1, 0, 'queued')
}

const research = (w: World): number => {
  addPipe(w.db, { name: 'research', enabled: 1, window_start: '00:00', window_end: '23:59', max_concurrent: 1 })
  return pipeNamed(w.db, 'research')?.id ?? 0
}

const leased = (): World => {
  const w = world()
  take(w.db, 1, NOW)
  return w
}

const TABLE: Record<string, Row> = {
  'a queued plan at its first step': { state: () => world(), want: { fire: at(0) } },
  'a plan this tick leased': { state: leased, mine: true, want: { fire: at(0) } },
  'a plan another live pid leased': { state: leased, want: { wait: 'leased', on: null } },
  'a research plan at its first step': {
    state: () => {
      const w = world()
      amend(w.db, 1, { template: 'research' })
      return w
    },
    want: { fire: mapOf('research').at(0) },
  },
  'a comms plan at its first step': {
    state: () => {
      const w = world()
      amend(w.db, 1, { template: 'comms' })
      return w
    },
    want: { fire: mapOf('comms').at(0) },
  },
  'a target not yet approved': { state: () => stepTo(world(), 1, 1), want: { wait: 'target_approval', on: null } },
  'a ready step with no proof': { state: () => stepTo(world(), 1, 6), want: { wait: 'ready_proof', on: null } },
  'a batch with no sign-off': { state: () => stepTo(world(), 1, 7), want: { wait: 'ceo_batch', on: null } },
  'a parked target': { state: () => world('cold'), want: { wait: 'target_parked', on: null } },
  'a build sharing a path with an older build': {
    state: () => {
      const w = another(stepTo(world(), 1, 2), 2, 1, 2)
      for (const id of [1, 2]) recordFiles(w.db, id, [{ path: 'src/hello.ts', is_new: false }])
      return w
    },
    id: 2,
    want: { wait: 'file_overlap', on: 1 },
  },
  'a queued plan behind a running one in a one-wide lane': {
    state: () => {
      const w = another(world(), 2, 1, 0)
      width(w.db, 1, 1)
      return w
    },
    want: { wait: 'over_cap', on: null },
  },
  'a queued plan behind a running one awaiting target approval in a one-wide lane': {
    state: behind(1), id: 2, want: { fire: at(0) },
  },
  'a queued plan behind a running one awaiting sign-off in a one-wide lane': {
    state: behind(7), id: 2, want: { fire: at(0) },
  },
  'a queued plan behind a running one awaiting its ready proof in a one-wide lane': {
    state: behind(6), id: 2, want: { wait: 'lane_over_cap', on: null },
  },
  'a plan on a second lane at cap 1': {
    state: () => {
      const w = world()
      const pipe = research(w)
      dial(w.db, 1, NOW.toISOString())
      return another(w, 2, pipe, 0)
    },
    id: 2,
    want: { wait: 'lane_over_cap', on: null },
  },
  'a plan on a second lane at cap 1 while another pid runs the first lane': {
    state: () => {
      const w = world()
      const pipe = research(w)
      dial(w.db, 1, NOW.toISOString())
      take(w.db, 1, NOW)
      return another(w, 2, pipe, 0, 'queued')
    },
    id: 2,
    want: { wait: 'lane_over_cap', on: null },
  },
  'a brief past the token ceiling': {
    state: () => {
      const w = stepTo(world(), 1, 1)
      approve(w.db, w.target)
      set(w.db, 'plan.token_ceiling', '0', 'ceo', NOW.toISOString())
      return w
    },
    want: { wait: 'token_ceiling', on: null, over: { spent: 0, ceiling: 0 } },
  },
}

const stored = (w: World): unknown[] => [planRows(w.db), held(w.db, NOW)]

for (const [name, { state, id = 1, mine = false, want }] of Object.entries(TABLE)) {
  test(name, () => {
    const w = state()
    const before = stored(w)
    expect(route(w.db, plan(w.db, id), NOW, mine ? holder(w.db, id, NOW) : null)).toEqual(want)
    expect(stored(w)).toEqual(before)
  })
}

test('the table has a row for every reason a plan waits', () => {
  const decided = new Set(Object.values(TABLE).map(({ want }) => 'fire' in want ? 'fire' : want.wait))
  expect(decided).toEqual(new Set([...WAIT.filter((w) => w !== 'no_step_map'), 'fire']))
})
