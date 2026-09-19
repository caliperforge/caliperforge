import { pr as readPr, type Pr } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { hold } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { cap, hhmm, zone } from '../store/lanes.ts'
import { advance, back, finish, internal, live, needsCeo, openPipes, rewind, underCap, type PipeRow, type PlanRow } from '../store/plans.ts'
import { at, last, type Step } from '../templates/pr-path.ts'
import { capture } from './capture.ts'
import type { Fired, Outcome } from './kind.ts'
import { started } from './signals.ts'
import type { Wire } from './push.ts'
import { fireBrief, fireReview, fireSeat } from './seat.ts'
import { blocked, kernel, proved, targetOf } from './steps.ts'
import { branchOf, checkout, internalBranch, languageOf, put, SELF, srcDir, titleOf } from './workspace.ts'

/** `read` and `wire` are the network a tick touches on its own account; both are injected so a test can drive a lap offline. */
export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date(),
  read: (repo: string, no: number) => Pr = readPr, wire?: Wire): Promise<Fired[]> {
  const today = now.toISOString().slice(0, 10)
  for (const signal of capture(db, read)) started(db, signal)
  const out: Fired[] = []
  for (const pipe of openPipes(db, hhmm(db, now)).slice(0, cap(db).cap)) {
    out.push(...await Promise.all(picks(db, pipe, today).map((plan) => one(db, root, pipe, plan, provider, wire))))
  }
  return out
}

/** The templates a step map exists for. A lane whose map is unwritten is on with nothing to step. */
const MAPPED = new Set(['pr_path'])

export interface Would {
  pipe: string
  plan: number
  step: number
  template: string
}

export interface Quiet {
  pipe: string
  live: number
}

export interface Dry {
  hhmm: string
  zone: number
  cap: number
  pipes: number
  would: Would[]
  quiet: Quiet[]
}

/**
 * The plans this pipe steps this tick, in priority order. A queued plan that is
 * blocked holds no slot; a running one holds the slot it already took.
 */
export function picks(db: Db, pipe: PipeRow, today: string): PlanRow[] {
  const mapped = live(db, pipe).filter((p) => MAPPED.has(p.template))
  const free = mapped.filter((p) => p.state === 'running' || blocked(db, p, today) === null)
  return underCap(pipe, free).filter((p) => p.state !== 'running' || blocked(db, p, today) === null)
}

/** What a tick would do, off the store alone: no `gh` call, no model, no row moved. */
export function dry(db: Db, now: Date = new Date()): Dry {
  const when = hhmm(db, now)
  const today = now.toISOString().slice(0, 10)
  const held = cap(db).cap
  const open = openPipes(db, when).slice(0, held).map((p) => ({ pipe: p, plans: picks(db, p, today) }))
  return {
    hhmm: when,
    zone: zone(db),
    cap: held,
    pipes: open.length,
    would: open.flatMap((o) => o.plans.map((p) => ({ pipe: o.pipe.name, plan: p.id, step: p.step, template: p.template }))),
    quiet: open.filter((o) => o.plans.length === 0)
      .map((o) => ({ pipe: o.pipe.name, live: live(db, o.pipe).length })),
  }
}

async function one(db: Db, root: string, pipe: PipeRow, plan: PlanRow, provider: Provider, wire?: Wire): Promise<Fired> {
  const tree = workspace(db, root, plan)
  const step = at(plan.step, tree.language)
  const outcome = tree.failed ?? await fire(db, root, plan, step, provider, wire)
  return {
    pipe: pipe.name,
    plan: plan.id,
    step: step.step,
    name: step.name,
    outcome: outcome.outcome,
    state: settle(db, root, plan, step, outcome),
    spans: outcome.spans,
    note: outcome.note,
  }
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
    return { language: null, failed: { outcome: 'refuse', spans: [tree.repo], note: `checkout: ${note}` } }
  }
  return { language: languageOf(srcDir(root, plan.id)), failed: null }
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
  if (outcome.rewind !== undefined) {
    rewind(db, plan.id, outcome.rewind)
    return 'running'
  }
  if (outcome.outcome === 'needs_ceo') {
    needsCeo(db, plan)
    return 'blocked_on_ceo'
  }
  if (outcome.outcome !== 'refuse') {
    proved(db, root, plan, step)
    if (last(step.step)) { finish(db, plan); return 'done' }
    advance(db, plan, step.step + 1)
    return hold(db, plan.id, step.step)
  }
  put(root, plan.id, 'refusal.md', refusalText(step, outcome))
  // step 2 is the build in templates/pr-path.ts
  return back(db, plan, step.fires === 'review' ? 2 : step.step - 1)
}

function refusalText(step: Step, outcome: Outcome): string {
  const spans = outcome.spans.length === 0 ? '  (none named)' : outcome.spans.map((s) => `  - ${s}`).join('\n')
  const words = outcome.message === undefined ? '' : `\n${outcome.message}\n`
  return `step ${String(step.step)} ${step.name} refused by ${step.runs}\n\n${outcome.note}\n\nspans:\n${spans}\n${words}`
}
