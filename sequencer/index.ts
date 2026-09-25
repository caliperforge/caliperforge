import { pr as readPr, type Pr, type Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { digestOf } from '../store/approvals.ts'
import { hold } from '../store/holds.ts'
import { logged, newestRun, runSince } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { clear as unlease, held, take, type Lease, type Taken } from '../store/leases.ts'
import { cap, hhmm, zone } from '../store/lanes.ts'
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
  read: (repo: string, no: number) => Pr = readPr, wire?: Wire, chain = 0, labels?: Read): Promise<Fired[]> {
  for (const signal of capture(db, read)) started(db, signal, root)
  if (labels !== undefined) intake(db, root, labels)
  reap(root, terminal(db))
  reprice(db, labels)
  const out: Fired[] = []
  const lanes = openPipes(db, hhmm(db, now))
    .map((pipe) => ({ pipe, routed: live(db, pipe).map((plan) => ({ plan, route: route(db, plan, now) })) }))
  waiting(db, lanes.flatMap((l) => l.routed.map(({ plan, route: r }) =>
    'fire' in r ? { plan: plan.id, why: null } : { plan: plan.id, why: r.wait, on: r.on })))
  for (const { pipe, routed } of lanes) {
    const mine = leased(db, routed.filter((r) => stepping(r.route)), now)
    const laps = await Promise.all(mine.map((m) => one(db, root, pipe, m, m.lease, provider, wire, chain)))
    out.push(...laps.flat())
  }
  await woke(db, root, provider, now)
  return out
}

/** A `token_ceiling` plan is leased too: `ceilinged` is its step. */
function stepping(r: Route): boolean {
  return 'fire' in r || 'over' in r
}

/** The live tick's budget for one job: well inside the lease ceiling, and long enough for a whole lap short of CI. */
export const CHAIN_MINUTES = 45

/** Steps one job may take in one tick: a full lap and two rebuilds, and a ceiling on a loop that spends no model. */
const STEPS = 20

/** #65: the picks this tick won the lease on; one another live tick holds is left where it stands. */
function leased(db: Db, picks: Leg[], now: Date): (Leg & { lease: Taken })[] {
  return picks.flatMap((pick) => {
    const lease = take(db, pick.plan.id, now)
    return lease === null ? [] : [{ ...pick, lease }]
  })
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
  provider: Provider, wire?: Wire, chain = 0): Promise<Fired[]> {
  const until = Date.now() + chain * 60_000
  const out: Fired[] = []
  try {
    let leg: Leg | null = first
    while (leg !== null) {
      const { plan, route: r } = leg
      if ('over' in r) {
        out.push(ceilinged(db, root, pipe, plan, r.over, lease))
        break
      }
      const lap = await stepped(db, root, pipe, plan, lease, provider, wire)
      out.push(lap.fired)
      const more = chain > 0 && Date.now() < until && out.length < STEPS && !lap.wait
      leg = more ? onward(db, first.plan.id, lease) : null
    }
    return out
  } finally {
    unlease(db, first.plan.id)
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
  provider: Provider, wire?: Wire): Promise<{ fired: Fired; wait: boolean }> {
  const tree = workspace(db, root, plan)
  const step = at(plan.step, tree.language)
  const mark = newestRun(db)
  const outcome = tree.failed ?? await made(db, root, plan, step, provider, wire)
  const state = settle(db, root, plan, step, outcome)
  logged(db, { plan: plan.id, kind: step.name, actor: step.runs, outcome: outcome.outcome, message: outcome.note,
    pointer: `step-${String(step.step)}`, run: runSince(db, plan.id, step.step, mark) })
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
  }
  return { fired, wait: outcome.held === true || outcome.blip === true }
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
async function made(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire): Promise<Outcome> {
  try {
    const out = await fire(db, root, plan, step, provider, wire)
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

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire): Promise<Outcome> {
  if (step.fires === 'brief') return fireBrief(db, root, plan, step, provider)
  if (step.fires === 'seat') return fireSeat(db, root, plan, step, provider)
  if (step.fires === 'review') {
    const standing = kept(db, root, plan, step)
    return standing === null ? fireRound(db, root, plan, step, provider) : Promise.resolve(standing)
  }
  return Promise.resolve(kernel(db, root, plan, wire))
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
    diff: step.step >= 3 ? digestOf(diffOf(root, plan.id)) : null })
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

/** A failed check or CI run is known by what failed, not by the one span every such failure shares. */
function fingerprintOf(step: Step, outcome: Outcome): string {
  const checked = outcome.spans.some((s) => s.startsWith('checks:') || s.startsWith('ci.red'))
  return fingerprint(step.step, outcome.spans, checked ? (outcome.message ?? '') : '')
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
