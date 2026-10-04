import { pr as readPr, type Pr, type Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import type { Db } from '../store/index.ts'
import { clear as unlease, drop, handOver, held, take, type Lease, type Taken } from '../store/leases.ts'
import { cap, hhmm, zone } from '../store/lanes.ts'
import { idle, keepWait } from '../store/now.ts'
import { type PlanRow, live, openPipes, planById, terminal, type PipeRow, waiting } from '../store/plans.ts'
import { capture, intake } from './capture.ts'
import { woke } from './coolite.ts'
import type { Fired } from './kind.ts'
import { reprice } from './priority.ts'
import { daily, started, weekly } from './signals.ts'
import { WIRE, type Wire } from './push.ts'
import { due, type Entry, stuck } from './drift.ts'
import { sunday } from '../cli/science.ts'
import { offered, route, working, type Route } from './next.ts'
import { reap } from './workspace.ts'
import { ceilinged, stepped } from './settle.ts'

/**
 * `read`, `wire` and `labels` are the network a tick touches on its own account; each is injected so a test can drive a lap
 * offline. `chain` is how many minutes a job may keep stepping inside this tick: the live tick passes
 * `CHAIN_MINUTES`, and a test that leaves it at 0 still sees one step per tick.
 */
export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date(),
  read: (repo: string, no: number) => Pr = readPr, wire?: Wire, chain = 0, labels?: Read, each = Infinity,
  apart?: Apart, lines?: string[], registry?: Entry[]): Promise<Fired[]> {
  for (const signal of capture(db, read, root, labels)) started(db, signal, root, wire)
  daily(db, now)
  weekly(db, now)
  if (registry !== undefined) {
    due(db, registry, now, wire ?? WIRE, read)
    stuck(db, root, registry, now)
    sunday(db, root, now)
  }
  if (labels !== undefined) (lines ?? []).push(...intake(db, root, labels))
  reap(root, terminal(db))
  reprice(db, labels)
  const out: Fired[] = []
  const lanes = openPipes(db, hhmm(db, now))
    .map((pipe) => ({ pipe, routed: live(db, pipe).map((plan) => ({ plan, route: route(db, plan, now) })) }))
  waiting(db, lanes.flatMap((l) => l.routed.map(({ plan, route: r }) =>
    'fire' in r ? { plan: plan.id, why: null } : { plan: plan.id, why: r.wait, on: r.on })))
  if (Number.isFinite(each)) {
    const laps = lanes.map(({ pipe, routed }) => lane(routed.filter((r) => stepping(r.route)), now, each,
      (m) => apart === undefined ? one(db, root, pipe, m, m.lease, provider, wire, chain, labels) : away(db, m, apart), db))
    out.push(...(await Promise.all(laps)).flat())
  } else {
    for (const { pipe, routed } of lanes) {
      const mine = leased(db, routed.filter((r) => stepping(r.route)), now)
      const laps = await Promise.all(mine.map((m) => one(db, root, pipe, m, m.lease, provider, wire, chain, labels)))
      out.push(...laps.flat())
    }
  }
  await woke(db, root, provider, now)
  return out
}

/**
 * A lane's `each` jobs this tick. A job that only waited spent no model and does not count: a job parked on the
 * checks lock must not take the lane's one lease from the jobs behind it.
 */
async function lane(picks: Leg[], now: Date, each: number, run: (m: Leg & { lease: Taken }) => Promise<Fired[]>,
  db: Db): Promise<Fired[]> {
  const out: Fired[] = []
  let ran = 0
  for (const pick of picks) {
    if (ran >= each) break
    const lease = take(db, pick.plan.id, now)
    if (lease === null) continue
    const fired = await run({ ...pick, lease })
    out.push(...fired)
    if (fired.length === 0 || !fired.every((f) => f.held === true)) ran += 1
  }
  return out
}

/** Runs one leased job in a process of its own and hands back what it fired. */
export type Apart = (plan: number, stole: number | null) => Promise<Fired[]>

/** A job whose process died before it took the lease frees its plan; one that died after leaves a dead pid, which the next tick takes over. */
async function away(db: Db, leg: Leg & { lease: Taken }, apart: Apart): Promise<Fired[]> {
  try {
    return await apart(leg.plan.id, leg.lease.stole)
  } finally {
    drop(db, leg.plan.id)
  }
}

/**
 * One leased job's laps, in the process `cf lap` forked for it. Step 3's checks and the slot wait block
 * the event loop, and an agent whose tool hook cannot answer stops with it. One process per job keeps a check
 * from freezing another lane's agent.
 */
export async function lap(db: Db, root: string, provider: Provider, plan: number, from: number, stole: number | null,
  chain = 0, read?: Read): Promise<Fired[]> {
  const lease = handOver(db, plan, from)
  if (lease === null) return []
  const taken = { ...lease, stole }
  const row = planById(db, plan)
  const pipe = openPipes(db, hhmm(db, new Date())).find((p) => p.id === row.pipe_id)
  if (pipe === undefined) {
    unlease(db, plan)
    return []
  }
  return one(db, root, pipe, { plan: row, route: route(db, row, new Date(), taken) }, taken, provider, undefined, chain, read)
}

/** A `token_ceiling` plan is leased too: `ceilinged` is its step. */
function stepping(r: Route): boolean {
  return 'fire' in r || 'over' in r
}

/**
 * Jobs the live tick leases per lane: one job per lane per tick, each in a process of its own; the tick fires every
 * minute, so the lanes fill in minutes.
 */
export const EACH = 1

/** The live tick's budget for one job: well inside the lease ceiling, and long enough for a whole lap short of CI. */
export const CHAIN_MINUTES = 45

/** Steps one job may take in one tick: a full lap and two rebuilds, and a ceiling on a loop that spends no model. */
const STEPS = 20

/** The picks this tick won the lease on; one another live tick holds is left where it stands. */
function leased(db: Db, picks: Leg[], now: Date, each = Infinity): (Leg & { lease: Taken })[] {
  const out: (Leg & { lease: Taken })[] = []
  for (const pick of picks) {
    if (out.length >= each) break
    const lease = take(db, pick.plan.id, now)
    if (lease !== null) out.push({ ...pick, lease })
  }
  return out
}

interface Leg {
  plan: PlanRow
  route: Route
}

interface Would {
  pipe: string
  plan: number
  step: number
  template: string
}

/** A lane the tick passed over. `ready` is what it would have stepped had the cap reached it. */
export interface Quiet {
  pipe: string
  live: number
  ready: number
}

export interface Dry {
  hhmm: string
  zone: number
  cap: number
  pipes: number
  would: Would[]
  quiet: Quiet[]
  held: Lease[]
}

/** What a tick would do, off the store alone: no `gh` call, no model, no row moved. */
export function dry(db: Db, now: Date = new Date()): Dry {
  const when = hhmm(db, now)
  const wide = cap(db).cap
  const offers = offered(db, now)
  const open = working(offers, wide)
  const taken = new Set(open.map((o) => o.pipe.id))
  return {
    hhmm: when,
    zone: zone(db),
    cap: wide,
    pipes: offers.length,
    held: held(db, now),
    would: offers.flatMap((o) => live(db, o.pipe).filter((p) => 'fire' in route(db, p, now))
      .map((p) => ({ pipe: o.pipe.name, plan: p.id, step: p.step, template: p.template }))),
    quiet: offers.filter((o) => !taken.has(o.pipe.id))
      .map((o) => ({ pipe: o.pipe.name, live: live(db, o.pipe).length, ready: o.plans.length })),
  }
}

/**
 * The lease goes on every way out, a throw included: the plan is free for the next tick either way. With a
 * `chain` budget the job keeps its lease and takes its next step at once, until it has to wait on something
 * outside the machine -- their CI, a person, a lane a person turned off -- or the budget runs out.
 */
async function one(db: Db, root: string, pipe: PipeRow, first: Leg, lease: Taken,
  provider: Provider, wire?: Wire, chain = 0, read?: Read): Promise<Fired[]> {
  const until = Date.now() + chain * 60_000
  const out: Fired[] = []
  let waited = false
  try {
    let leg: Leg | null = first
    while (leg !== null) {
      const { plan, route: r } = leg
      if ('over' in r) {
        out.push(ceilinged(db, root, pipe, plan, r.over, lease))
        break
      }
      const lap = await stepped(db, root, pipe, plan, lease, provider, wire, read)
      out.push(lap.fired)
      waited = lap.wait
      const more = chain > 0 && Date.now() < until && out.length < STEPS && !lap.wait
      leg = more ? onward(db, first.plan.id, lease) : null
    }
    return out
  } finally {
    unlease(db, first.plan.id)
    if (waited) keepWait(db, first.plan.id)
    else idle(db, first.plan.id)
  }
}

/** The job as the store now has it, if it can take another step in this tick: still running, and routed to step. */
function onward(db: Db, id: number, lease: Taken): Leg | null {
  const plan = planById(db, id)
  if (plan.state !== 'running') return null
  const r = route(db, plan, new Date(), lease)
  return stepping(r) ? { plan, route: r } : null
}
