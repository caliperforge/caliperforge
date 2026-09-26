import { expect, test } from 'vitest'
import { record as recordFiles } from '../../store/files.ts'
import { dial } from '../../store/lanes.ts'
import { holder, take } from '../../store/leases.ts'
import { WAIT } from '../../store/plans.ts'
import { at } from '../../templates/pr-path.ts'
import { route, type Route } from '../next.ts'
import { approve, plan, world, type World } from './world.ts'

const NOW = new Date()

interface Row {
  state: () => World
  id?: number
  mine?: boolean
  want: Route
}

const stepTo = (w: World, id: number, step: number): World => {
  w.db.prepare("UPDATE plans SET step = ?, state = 'running' WHERE id = ?").run(step, id)
  return w
}

const another = (w: World, id: number, pipe: number, step: number): World => {
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (?, ?, 1, 'pr_path', 'running', '2026-09-18T00:00:00.000Z', ?, 0)`).run(id, pipe, step)
  return w
}

const behind = (step: number) => (): World => {
  const w = stepTo(world(), 1, step)
  w.db.prepare('UPDATE pipes SET max_concurrent = 1 WHERE id = 1').run()
  w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
    VALUES (2, 1, 1, 'pr_path', 'queued', '2026-09-18T00:00:00.000Z', 0, 0)`).run()
  return w
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
  'a template with no step map': {
    state: () => {
      const w = world()
      w.db.prepare("UPDATE plans SET template = 'research' WHERE id = 1").run()
      return w
    },
    want: { wait: 'no_step_map', on: null },
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
      w.db.prepare('UPDATE pipes SET max_concurrent = 1 WHERE id = 1').run()
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
      w.db.prepare(`INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent)
        VALUES (2, 'research', 1, '00:00', '23:59', 1)`).run()
      dial(w.db, 1, NOW.toISOString())
      return another(w, 2, 2, 0)
    },
    id: 2,
    want: { wait: 'lane_over_cap', on: null },
  },
  'a plan on a second lane at cap 1 while another pid runs the first lane': {
    state: () => {
      const w = world()
      w.db.prepare(`INSERT INTO pipes (id, name, enabled, window_start, window_end, max_concurrent)
        VALUES (2, 'research', 1, '00:00', '23:59', 1)`).run()
      dial(w.db, 1, NOW.toISOString())
      take(w.db, 1, NOW)
      w.db.prepare(`INSERT INTO plans (id, pipe_id, target_id, template, state, queued_at, step, retries)
        VALUES (2, 2, 1, 'pr_path', 'queued', '2026-09-18T00:00:00.000Z', 0, 0)`).run()
      return w
    },
    id: 2,
    want: { wait: 'lane_over_cap', on: null },
  },
  'a brief past the token ceiling': {
    state: () => {
      const w = stepTo(world(), 1, 1)
      approve(w.db, w.target)
      w.db.prepare("UPDATE settings SET value = '0' WHERE key = 'plan.token_ceiling'").run()
      return w
    },
    want: { wait: 'token_ceiling', on: null, over: { spent: 0, ceiling: 0 } },
  },
}

const stored = (w: World): unknown[] => ['plans', 'leases'].map((t) => w.db.prepare(`SELECT * FROM ${t}`).all())

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
  expect(decided).toEqual(new Set([...WAIT, 'fire']))
})
