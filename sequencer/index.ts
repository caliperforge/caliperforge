import { pr as readPr, type Pr } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { digestOf } from '../store/approvals.ts'
import { hold } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { clear as unlease, held, take, type Lease, type Taken } from '../store/leases.ts'
import { cap, hhmm, zone } from '../store/lanes.ts'
import { advance, back, finish, internal, live, needsCeo, openPipes, PlanRow, rewind, underCap, waiting, type PipeRow, type Wait } from '../store/plans.ts'
import { blipped, fingerprint, overBudget, refused, WHY, type Why } from '../store/refusals.ts'
import { at, last, type Step } from '../templates/pr-path.ts'
import { capture } from './capture.ts'
import type { Fired, Outcome } from './kind.ts'
import { started } from './signals.ts'
import { parted } from './split.ts'
import type { Wire } from './push.ts'
import { fireBrief, fireReview, fireSeat } from './seat.ts'
import { blocked, kernel, proved, targetOf } from './steps.ts'
import { languageFor } from './route.ts'
import { branchOf, checkout, diffOf, internalBranch, maybe, put, SELF, srcDir, titleOf } from './workspace.ts'

/**
 * `read` and `wire` are the network a tick touches on its own account; both are injected so a test can drive a lap offline.
 * `chain` is how many minutes a job may keep stepping inside this tick (#78, widened): the live tick passes `CHAIN_MINUTES`,
 * and a test that leaves it at 0 still sees one step per tick.
 */
export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date(),
  read: (repo: string, no: number) => Pr = readPr, wire?: Wire, chain = 0): Promise<Fired[]> {
  for (const signal of capture(db, read)) started(db, signal, root)
  const out: Fired[] = []
  const offers = offered(db, now)
  const open = working(offers, cap(db).cap)
  waited(db, offers, open, now)
  for (const { pipe, plans } of open) {
    const mine = leased(db, plans, now)
    const laps = await Promise.all(mine.map((m) => one(db, root, pipe, m.plan, m.lease, provider, wire, chain)))
    out.push(...laps.flat())
  }
  return out
}

/**
 * #140: every live plan on an open lane either takes a step this tick or records why it did not, so the
 * reason is a stored fact and not a `blocked()` return the tick threw away. A plan it steps carries none.
 */
function waited(db: Db, offers: Offer[], open: Offer[], now: Date): void {
  const leases = new Set(held(db, now).map((l) => l.plan))
  const reached = new Set(open.map((o) => o.pipe.id))
  const taken = new Set(open.flatMap((o) => o.plans.map((p) => p.id)))
  waiting(db, offers.flatMap((o) => live(db, o.pipe).map((plan) => ({
    plan: plan.id,
    why: taken.has(plan.id) ? null : why(db, plan, leases, reached.has(o.pipe.id)),
  }))))
}

/** Why this live plan is not being stepped, in the order the tick decides it. */
function why(db: Db, plan: PlanRow, leases: Set<number>, reached: boolean): Wait {
  if (leases.has(plan.id)) return 'leased'
  if (!MAPPED.has(plan.template)) return 'no_step_map'
  return blocked(db, plan) ?? (reached ? 'over_cap' : 'lane_over_cap')
}

/** The live tick's budget for one job: well inside the lease ceiling, and long enough for a whole lap short of CI. */
export const CHAIN_MINUTES = 45

/** Steps one job may take in one tick: a full lap and two rebuilds, and a ceiling on a loop that spends no model. */
const STEPS = 20

/** #65: the picks this tick won the lease on; one another live tick holds is left where it stands. */
function leased(db: Db, plans: PlanRow[], now: Date): { plan: PlanRow; lease: Taken }[] {
  return plans.flatMap((plan) => {
    const lease = take(db, plan.id, now)
    return lease === null ? [] : [{ plan, lease }]
  })
}

export interface Offer {
  pipe: PipeRow
  plans: PlanRow[]
}

/** Every open lane and what it would step, asked once: one reading of the queues serves the whole tick. */
function offered(db: Db, now: Date): Offer[] {
  return openPipes(db, hhmm(db, now)).map((pipe) => ({ pipe, plans: picks(db, pipe, now) }))
}

/**
 * #125: the cap is spent on lanes that can use it. A lane with nothing to step takes no slot, so at
 * cap 1 an idle lane no longer holds the only slot against a lane with a plan it could step; among
 * lanes that can step, the lower id still wins, which is the order `openPipes` returns.
 */
function working(offers: Offer[], wide: number): Offer[] {
  return offers.filter((o) => o.plans.length > 0).slice(0, wide)
}

/** The templates a step map exists for. A lane whose map is unwritten is on with nothing to step. */
const MAPPED = new Set(['pr_path'])

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

/**
 * The plans this pipe steps this tick, in priority order. A queued plan that is
 * blocked holds no slot; a running one holds the slot it already took, and so does
 * one another tick has leased, which this tick offers to nobody.
 */
export function picks(db: Db, pipe: PipeRow, now: Date = new Date()): PlanRow[] {
  const leases = new Set(held(db, now).map((l) => l.plan))
  const mapped = live(db, pipe).filter((p) => MAPPED.has(p.template))
  const free = mapped.filter((p) => p.state === 'running' || leases.has(p.id) || blocked(db, p) === null)
  return underCap(pipe, free, leases)
    .filter((p) => !leases.has(p.id) && (p.state !== 'running' || blocked(db, p) === null))
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
    would: open.flatMap((o) => o.plans.map((p) => ({ pipe: o.pipe.name, plan: p.id, step: p.step, template: p.template }))),
    quiet: offers.filter((o) => !taken.has(o.pipe.id))
      .map((o) => ({ pipe: o.pipe.name, live: live(db, o.pipe).length, ready: o.plans.length })),
  }
}

/**
 * The lease goes on every way out, a throw included: the plan is free for the next tick either way. With a
 * `chain` budget the job keeps its lease and takes its next step at once, until it has to wait on something
 * outside the machine -- their CI, a person, a lane the CEO turned off -- or the budget runs out.
 */
async function one(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken,
  provider: Provider, wire?: Wire, chain = 0): Promise<Fired[]> {
  const until = Date.now() + chain * 60_000
  const out: Fired[] = []
  try {
    let row: PlanRow | null = plan
    while (row !== null) {
      const lap = await stepped(db, root, pipe, row, lease, provider, wire)
      out.push(lap.fired)
      const more = chain > 0 && Date.now() < until && out.length < STEPS && !lap.wait
      row = more ? onward(db, pipe, row.id) : null
    }
    return out
  } finally {
    unlease(db, plan.id)
  }
}

/** The job as the store now has it, if it can take another step in this tick: still running, not blocked, its lane still open. */
function onward(db: Db, pipe: PipeRow, id: number): PlanRow | null {
  if (!openPipes(db, hhmm(db, new Date())).some((p) => p.id === pipe.id)) return null
  const row = PlanRow.parse(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
  return row.state === 'running' && blocked(db, row) === null ? row : null
}

/** `wait` is a step that settled by waiting: a CI still running, or a checkout the network failed. Neither is worth asking again in the same tick. */
async function stepped(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken,
  provider: Provider, wire?: Wire): Promise<{ fired: Fired; wait: boolean }> {
  const fires = at(plan.step).fires
  const over = fires === 'brief' || fires === 'seat' || fires === 'review' ? overBudget(db, plan.id) : null
  if (over !== null) return { fired: ceilinged(db, root, pipe, plan, over, lease), wait: true }
  const tree = workspace(db, root, plan)
  const step = at(plan.step, tree.language)
  const made = tree.failed ?? await fire(db, root, plan, step, provider, wire)
  const outcome = made.parts === undefined ? made : parted(db, root, plan, made.parts, wire)
  const state = settle(db, root, plan, step, outcome)
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
    return { language: null, failed: { outcome: 'refuse', spans: [tree.repo], note: `checkout: ${note}`, blip: true } }
  }
  return { language: languageFor(db, plan, srcDir(root, plan.id)), failed: null }
}

/**
 * Which repository the branch is cut in and what it is called: a stranger's repo and
 * `<repo>-<issue>-a<attempt>` for a target, our own repo and `p<plan>-<slug>` for an issue
 * of ours. Either way the clone is our fork and the base is that repo's `main`.
 */
function treeOf(db: Db, root: string, plan: PlanRow): { repo: string; branch: string } | null {
  if (internal(plan)) {
    return { repo: SELF, branch: internalBranch(plan.id, titleOf(root, plan.id) ?? `plan ${String(plan.id)}`) }
  }
  const row = targetOf(db, plan)
  return row === null ? null : { repo: row.repo, branch: branchOf(row.repo, row.issue_no, plan.retries + 1) }
}

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire): Promise<Outcome> {
  if (step.fires === 'brief') return fireBrief(db, root, plan, step, provider)
  if (step.fires === 'seat') return fireSeat(db, root, plan, step, provider)
  if (step.fires === 'review') return fireReview(db, root, plan, step, provider)
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
  if (outcome.rewind !== undefined) {
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
  return back(db, plan, outcome.to ?? backTo(step), why !== 'again')
}

/** Step 2 is the build in templates/pr-path.ts. */
const BUILD = 2

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
