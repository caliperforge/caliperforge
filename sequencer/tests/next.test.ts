import { expect, test } from 'vitest'
import { logged } from '../../store/events.ts'
import { record as recordFiles } from '../../store/files.ts'
import { amend, dial, enable, set, width } from '../../store/lanes.ts'
import { held, holder, take } from '../../store/leases.ts'
import { addPipe, addPlan, pipeNamed, planRows, putPlan, WAIT, type PlanRow } from '../../store/plans.ts'
import { at } from '../../templates/pr-path.ts'
import { lanes, route, type Route } from '../next.ts'
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
  'a research plan whose long job runs': {
    state: () => {
      const w = stepTo(world(), 1, 1)
      amend(w.db, 1, { template: 'research' })
      logged(w.db, { plan: 1, kind: 'long_job', actor: 'started', outcome: 'pass', message: 'sleep 30', pointer: null, run: null })
      return w
    },
    want: { wait: 'long_job', on: null },
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
  'a bench score while another leased bench plan scores': {
    state: () => {
      const w = world()
      for (const id of [2, 3]) {
        putPlan(w.db, { id, pipe_id: 1, target_id: null, template: 'bench', state: 'queued', queued_at: '2026-09-18T00:00:00.000Z', step: 2, retries: 0 })
      }
      take(w.db, 2, NOW)
      return w
    },
    id: 3,
    want: { wait: 'bench_score_busy', on: null },
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
    state: behind(6), id: 2, want: { fire: at(0) },
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

const FIX = 'https://github.com/caliperforge/caliperforge/issues/90'

/** The world's lane switched off by settle, a queued fix with origin FIX, and the director filing FIX when `filed`. */
function settled(filed: boolean): { w: World; fix: number } {
  const w = world()
  enable(w.db, w.pipe.id, false)
  logged(w.db, { plan: 1, kind: 'pipe', actor: 'settle', outcome: 'escalate', message: 'lane off', pointer: null, run: null })
  if (filed) logged(w.db, { plan: 1, kind: 'director', actor: 'director', outcome: 'pass', message: 'file: fix', pointer: FIX, run: null })
  const fix = addPlan(w.db, { pipe_id: w.pipe.id, target_id: null, template: 'pr_path', state: 'queued', queued_at: '2026-10-13',
    lane: 'machine', seat: 'typescript_specialist', origin: FIX, step: 0 })
  return { w, fix }
}

const offeredOn = (w: World) => lanes(w.db, NOW).filter((l) => l.pipe.id === w.pipe.id)
  .map(({ pipe, plans }) => ({ width: pipe.max_concurrent, plans: plans.map((p) => p.id) }))

test('a settled-off lane steps only its filed fix, one wide', () => {
  const { w, fix } = settled(true)
  expect(offeredOn(w)).toEqual([{ width: 1, plans: [fix] }])
})

test('a settled-off lane with no filed fix offers nothing', () => {
  expect(offeredOn(settled(false).w)).toEqual([])
})

test('a lane a ceo or coo touched after settle stays fully off', () => {
  for (const actor of ['ceo', 'coo']) {
    const { w } = settled(true)
    logged(w.db, { plan: null, kind: 'pipe', actor, outcome: 'pass', message: `${w.pipe.name} width 1`, pointer: null, run: null })
    expect(offeredOn(w)).toEqual([])
  }
})

test('the table has a row for every reason a plan waits', () => {
  const decided = new Set(Object.values(TABLE).map(({ want }) => 'fire' in want ? 'fire' : want.wait))
  expect(decided).toEqual(new Set([...WAIT.filter((w) => w !== 'no_step_map' && w !== 'bench_night'), 'fire']))
})
