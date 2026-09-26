import { pr as readPr, type Pr, type Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { digestOf } from '../store/approvals.ts'
import { hold } from '../store/holds.ts'
import { logged, newestRun, runSince } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { clear as unlease, drop, handOver, held, take, type Lease, type Taken } from '../store/leases.ts'
import { cap, hhmm, zone } from '../store/lanes.ts'
import { busy, idle, keepWait } from '../store/now.ts'
import { PlanRow, advance, back, finish, internal, live, needsCeo, openPipes, rewind, terminal, type PipeRow, waiting } from '../store/plans.ts'
import { blipped, fingerprint, refused, WHY, type Why } from '../store/refusals.ts'
import { at, last, type Step } from '../templates/pr-path.ts'
import { capture, intake } from './capture.ts'
import { woke } from './orchestrator.ts'
import type { Fired, Outcome } from './kind.ts'
import { reprice } from './priority.ts'
import { started } from './signals.ts'
import { parted } from './split.ts'
import type { Wire } from './push.ts'
import { fireRound } from './quick.ts'
import { fireBrief, fireSeat } from './seat.ts'
import { offered, route, working, type Route } from './next.ts'
import { kept, kernel, proved, targetOf } from './steps.ts'
import { languageFor } from './route.ts'
import { branchOf, checkout, diffOf, internalBranch, maybe, put, reap, srcDir, titleOf } from './workspace.ts'
import { homeOf } from './home.ts'

/**
 * `read`, `wire` and `labels` are the network a tick touches on its own account; each is injected so a test can drive a lap
 * offline. `chain` is how many minutes a job may keep stepping inside this tick (#78, widened): the live tick passes
 * `CHAIN_MINUTES`, and a test that leaves it at 0 still sees one step per tick.
 */
export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date(),
  read: (repo: string, no: number) => Pr = readPr, wire?: Wire, chain = 0, labels?: Read, each = Infinity,
  apart?: Apart): Promise<Fired[]> {
  for (const signal of capture(db, read, root, labels)) started(db, signal, root)
  if (labels !== undefined) intake(db, root, labels)
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
 * A lane's `each` jobs this tick. A job that only waited spent no model and does not count: on 09-25 plan 159
 * sat on the checks lock and took the Atelier lane's one lease every minute, so plans 164 and 166 never started.
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
 * #311: one leased job's laps, in the process `cf lap` forked for it. Step 3's checks and the slot wait block
 * the event loop, and an agent whose tool hook cannot answer stops with it: on 09-25 two reviews logged 23
 * minutes for 12 seconds of model. One process per job keeps a check from freezing another lane's agent.
 */
export async function lap(db: Db, root: string, provider: Provider, plan: number, from: number, stole: number | null,
  chain = 0, read?: Read): Promise<Fired[]> {
  const lease = handOver(db, plan, from)
  if (lease === null) return []
  const taken = { ...lease, stole }
  const row = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(plan))
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
 * Jobs the live tick leases per lane. Step 3's checks run synchronously, so every job in one tick waited on the slowest
 * test run: on 09-25 one job's suite froze five others for 20+ minutes, and the Atelier lane waited behind the machine
 * lane. One job per lane per tick, each in a process of its own (#311); the tick fires every minute, so the lanes fill in minutes.
 */
export const EACH = 1

/** The live tick's budget for one job: well inside the lease ceiling, and long enough for a whole lap short of CI. */
export const CHAIN_MINUTES = 45

/** Steps one job may take in one tick: a full lap and two rebuilds, and a ceiling on a loop that spends no model. */
const STEPS = 20

/** #65: the picks this tick won the lease on; one another live tick holds is left where it stands. */
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

export interface Would {
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
 * outside the machine -- their CI, a person, a lane the CEO turned off -- or the budget runs out.
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
  const plan = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
  if (plan.state !== 'running') return null
  const r = route(db, plan, new Date(), lease)
  return stepping(r) ? { plan, route: r } : null
}

/** `wait` is a step that settled by waiting: a CI still running, or a checkout the network failed. Neither is worth asking again in the same tick. */
async function stepped(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken,
  provider: Provider, wire?: Wire, read?: Read): Promise<{ fired: Fired; wait: boolean }> {
  const tree = workspace(db, root, plan)
  const step = at(plan.step, tree.language)
  const mark = newestRun(db)
  const verdicts = newestVerdict(db)
  const outcome = tree.failed ?? await made(db, root, plan, step, provider, wire, read)
  const state = settle(db, root, plan, step, outcome)
  logged(db, { plan: plan.id, kind: step.name, actor: step.runs, outcome: outcome.outcome, message: outcome.note,
    pointer: pointer(db, plan.id, step, verdicts), run: runSince(db, plan.id, step.step, mark) })
  const fired: Fired = {
    pipe: pipe.name,
    plan: plan.id,
    step: step.step,
    name: step.name,
    outcome: outcome.outcome,
    state,
    spans: outcome.spans,
    note: outcome.note,
    stole: lease.stole,
    ...(outcome.held === true ? { held: true as const } : {}),
  }
  return { fired, wait: outcome.held === true || outcome.blip === true }
}

function newestVerdict(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM verdicts').get() as { id: number }).id
}

function pointer(db: Db, plan: number, step: Step, after: number): string {
  if (step.fires === 'brief') return `plans:${String(plan)}`
  const own = step.fires === 'review'
    ? (db.prepare(`SELECT max(id) AS id FROM verdicts
        WHERE plan = ? AND step = ? AND kind = 'review' AND quick_lane = 0 AND id > ?`)
      .get(plan, step.step, after) as { id: number | null }).id
    : null
  return own === null ? `step-${String(step.step)}` : `verdicts:${String(own)}`
}

/** The job stops before its next model run, with what it spent written where a person will read it. */
function ceilinged(db: Db, root: string, pipe: PipeRow, plan: PlanRow, over: { spent: number; ceiling: number },
  lease: Taken): Fired {
  const million = (n: number): string => `${(n / 1e6).toFixed(1)}M`
  const note = `spent ${million(over.spent)} tokens since a person last sent it round, past the ${million(over.ceiling)} ceiling`
  put(root, plan.id, 'refusal.md', `${maybe(root, plan.id, 'refusal.md') ?? ''}\n# Stopped\n\n${note}.\n`)
  needsCeo(db, plan)
  waiting(db, [{ plan: plan.id, why: 'token_ceiling' }])
  const step = at(plan.step)
  logged(db, { plan: plan.id, kind: step.name, actor: 'token_ceiling', outcome: 'refuse', message: note,
    pointer: `step-${String(step.step)}`, run: null })
  return { pipe: pipe.name, plan: plan.id, step: step.step, name: step.name, outcome: 'refuse',
    state: 'blocked_on_ceo', spans: ['ceiling'], note, stole: lease.stole }
}

/**
 * The checkout the plan's seats read and write. A plan parked on a cold pulse or still
 * waiting on `cf approve target` never earns one, so it is made on the first step that
 * needs a tree — step 1, where the brief is written against the code — and not at queue
 * time; the language it turns out to be written in is what picks the builder.
 */
function workspace(db: Db, root: string, plan: PlanRow): { language: string | null; failed: Outcome | null } {
  const fires = at(plan.step).fires
  const tree = fires === 'brief' || fires === 'seat' || fires === 'review' ? treeOf(db, root, plan) : null
  if (tree === null) return { language: null, failed: null }
  try {
    checkout(root, plan.id, tree.repo, tree.branch)
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    if (OFFLINE.test(note)) return { language: null, failed: thrown(at(plan.step), note) }
    return { language: null, failed: { outcome: 'refuse', spans: [tree.repo], note: `checkout: ${note}`, blip: true } }
  }
  return { language: languageFor(db, plan, srcDir(root, plan.id)), failed: null }
}

/**
 * Which repository the branch is cut in and what it is called: a stranger's repo and
 * `<repo>-<issue>[-<part>]-a<attempt>` for a target, our own repo and `p<plan>-<slug>` for an issue
 * of ours. Either way the clone is our fork and the base is that repo's `main`.
 */
function treeOf(db: Db, root: string, plan: PlanRow): { repo: string; branch: string } | null {
  if (internal(plan)) {
    return { repo: homeOf(plan), branch: internalBranch(plan.id, titleOf(root, plan.id) ?? `plan ${String(plan.id)}`) }
  }
  const row = targetOf(db, plan)
  return row === null ? null : { repo: row.repo, branch: branchOf(row.repo, row.issue_no, plan.retries + 1, row.part) }
}

/** The first line goes in the span: two plans that threw differently must not match as `shared` and turn the lane off. */
async function made(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire, read?: Read): Promise<Outcome> {
  try {
    const out = await fire(db, root, plan, step, provider, wire, read)
    return out.parts === undefined ? out : parted(db, root, plan, out.parts, wire)
  } catch (error) {
    return thrown(step, error instanceof Error ? error.message : String(error))
  }
}

/**
 * The host losing its network is not the job's fault. On 09-25 a Wi-Fi drop made four jobs' `git fetch` throw at
 * step 3; each became a refusal, a person was asked, and two alike turned the Atelier lane off as a fault on main.
 * Such a throw holds the job on its step, uncounted, and the next tick tries again.
 */
const OFFLINE = /Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|Network is unreachable|Failed to connect to|Connection timed out/

export function thrown(step: Step, message: string): Outcome {
  if (OFFLINE.test(message)) {
    return { outcome: 'pass', held: true, spans: ['offline'], note: `step ${String(step.step)} ${step.name}: the network is down; the next tick tries again` }
  }
  return { outcome: 'refuse', spans: [`threw: ${message.split('\n')[0] ?? ''}`],
    note: `step ${String(step.step)} ${step.name} threw`, message, to: step.step }
}

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire, read?: Read): Promise<Outcome> {
  if (step.fires === 'brief') return model(db, plan, step, () => fireBrief(db, root, plan, step, provider))
  if (step.fires === 'seat') return model(db, plan, step, () => fireSeat(db, root, plan, step, provider))
  if (step.fires === 'review') {
    const standing = kept(db, root, plan, step)
    return standing === null ? model(db, plan, step, () => fireRound(db, root, plan, step, provider)) : Promise.resolve(standing)
  }
  return Promise.resolve(kernel(db, root, plan, wire, read))
}

function model(db: Db, plan: PlanRow, step: Step, run: () => Promise<Outcome>): Promise<Outcome> {
  busy(db, plan.id, 'model', `${step.runs} step ${String(step.step)}`)
  return run()
}

function settle(db: Db, root: string, plan: PlanRow, step: Step, outcome: Outcome): string {
  if (outcome.held === true) return 'running'
  if (outcome.blip === true) return blip(db, root, plan, step, outcome)
  if (outcome.split === true) {
    db.prepare("UPDATE plans SET state = 'done' WHERE id = ?").run(plan.id)
    return 'done'
  }
  if (outcome.outcome === 'refuse') put(root, plan.id, 'refusal.md', refusalText(step, outcome))
  if (outcome.rewind !== undefined && outcome.outcome !== 'refuse') {
    rewind(db, plan.id, outcome.rewind)
    return 'running'
  }
  if (outcome.outcome === 'needs_ceo') {
    needsCeo(db, plan)
    return 'blocked_on_ceo'
  }
  if (outcome.outcome !== 'refuse') {
    return db.transaction((): string => {
      proved(db, root, plan, step)
      if (last(step.step)) { finish(db, plan); return 'done' }
      advance(db, plan, step.step + 1)
      return hold(db, plan.id, step.step)
    })()
  }
  const why = refused(db, { plan: plan.id, step: step.step, fingerprint: fingerprintOf(step, outcome),
    diff: step.step >= 3 ? digestOf(diffOf(root, plan.id)) : null, moved: outcome.moved })
  if (why !== 'again') stopped(root, plan.id, why)
  if (why === 'shared') db.prepare('UPDATE pipes SET enabled = 0 WHERE id = ?').run(plan.pipe_id)
  if (outcome.rewind !== undefined && why === 'again') {
    rewind(db, plan.id, outcome.rewind)
    return 'running'
  }
  return back(db, plan, outcome.to ?? backTo(step), why !== 'again')
}

/** Step 2 is the build in templates/pr-path.ts. */
const BUILD = 2

/**
 * #119. A conflicting merge at step 3 rewinds onto a build that cannot see main's side, so the
 * rebuild lands on the old base and the next merge conflicts the same way: plan 62 went round five
 * times on 09-21 at 300-470k a lap. The rewind stands -- a moved main is not the builder's fault and
 * costs it no retry -- but the refusal is now recorded like any other, so the second identical
 * conflict is a repeat and the plan waits for a person.
 */

/**
 * Where a refusal sends the job: a review's to the build, a build's back to the build -- the brief it used to
 * fall back to never changes once a builder has run, so that detour cost a tick and bought nothing -- and a
 * kernel step's to the step before it.
 */
function backTo(step: Step): number {
  if (step.fires === 'review') return BUILD
  return step.fires === 'seat' ? step.step : step.step - 1
}

/** A failed checkout leaves the plan on its step for the next tick, until it has failed `BLIPS` times in a row. */
function blip(db: Db, root: string, plan: PlanRow, step: Step, outcome: Outcome): string {
  const why = blipped(db, plan.id, step.step)
  if (why === 'again') return 'running'
  put(root, plan.id, 'refusal.md', refusalText(step, outcome))
  stopped(root, plan.id, why)
  needsCeo(db, plan)
  return 'blocked_on_ceo'
}

/**
 * A failed check or CI run is known by what failed, not by the one span every such failure shares. So is a
 * `text:N` span, a line of this job's own brief or handback: plans 24 and 130 both drew "text:5
 * identifier.unresolved" for different names, read as one fault on main, and the internal lane went off on 09-25.
 */
export function fingerprintOf(step: Step, outcome: Outcome): string {
  const checked = outcome.spans.some((s) => s.startsWith('checks:') || s.startsWith('ci.red'))
  const own = outcome.spans.some((s) => s.startsWith('text:'))
  return fingerprint(step.step, outcome.spans, checked ? (outcome.message ?? '') : own ? outcome.note : '')
}

function stopped(root: string, plan: number, why: Exclude<Why, 'again'>): void {
  put(root, plan, 'refusal.md', `${maybe(root, plan, 'refusal.md') ?? ''}
# Stopped

${WHY[why]}.
`)
}

function refusalText(step: Step, outcome: Outcome): string {
  const spans = outcome.spans.length === 0 ? '  (none named)' : outcome.spans.map((s) => `  - ${s}`).join('\n')
  const words = outcome.message === undefined ? '' : `\n${outcome.message}\n`
  return `step ${String(step.step)} ${step.name} refused by ${step.runs}\n\n${outcome.note}\n\nspans:\n${spans}\n${words}`
}
