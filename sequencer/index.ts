import { pr as readPr, type Pr } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import type { Db } from '../store/index.ts'
import { cap } from '../store/lanes.ts'
import { advance, back, clock, finish, live, needsCeo, openPipes, underCap, type PipeRow, type PlanRow } from '../store/plans.ts'
import { at, last, type Step } from '../templates/pr-path.ts'
import { capture } from './capture.ts'
import type { Fired, Outcome } from './kind.ts'
import { started } from './signals.ts'
import { fireReview, fireSeat } from './seat.ts'
import { blocked, kernel, proved, targetOf } from './steps.ts'
import { checkout, languageOf, put, srcDir } from './workspace.ts'

/** `read` is the one network reader a tick does on its own account; it is injected so a test can drive a lap offline. */
export async function tick(db: Db, root: string, provider: Provider, now: Date = new Date(),
  read: (repo: string, no: number) => Pr = readPr): Promise<Fired[]> {
  const today = now.toISOString().slice(0, 10)
  for (const signal of capture(db, read)) started(db, signal)
  const out: Fired[] = []
  for (const pipe of openPipes(db, clock(now)).slice(0, cap(db).cap)) {
    for (const plan of picks(db, pipe, today)) out.push(await one(db, root, pipe, plan, provider))
  }
  return out
}

/**
 * The plans this pipe steps this tick, in priority order. A queued plan that is
 * blocked holds no slot; a running one holds the slot it already took.
 */
export function picks(db: Db, pipe: PipeRow, today: string): PlanRow[] {
  const free = live(db, pipe).filter((p) => p.state === 'running' || blocked(db, p, today) === null)
  return underCap(pipe, free).filter((p) => blocked(db, p, today) === null)
}

async function one(db: Db, root: string, pipe: PipeRow, plan: PlanRow, provider: Provider): Promise<Fired> {
  const tree = workspace(db, root, plan)
  const step = at(plan.step, tree.language)
  const outcome = tree.failed ?? await fire(db, root, plan, step, provider)
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
 * The checkout the plan's seats read and write. A plan parked on a cold pulse
 * or refused at the ruling never earns one, so it is made on the first step
 * that needs a tree and not at queue time — and the language it turns out to
 * be written in is what picks the builder.
 */
function workspace(db: Db, root: string, plan: PlanRow): { language: string | null; failed: Outcome | null } {
  const row = targetOf(db, plan)
  const fires = at(plan.step).fires
  if (row === null || (fires !== 'seat' && fires !== 'review')) return { language: null, failed: null }
  try {
    checkout(root, plan.id, row.repo, row.issue_no, plan.retries + 1)
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    return { language: null, failed: { outcome: 'refuse', spans: [`${row.repo}#${String(row.issue_no)}`], note: `checkout: ${note}` } }
  }
  return { language: languageOf(srcDir(root, plan.id)), failed: null }
}

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (step.fires === 'seat') return fireSeat(db, root, plan, step, provider)
  if (step.fires === 'review') return fireReview(db, root, plan, step, provider)
  return Promise.resolve(kernel(db, root, plan))
}

function settle(db: Db, root: string, plan: PlanRow, step: Step, outcome: Outcome): string {
  if (outcome.outcome === 'needs_ceo') {
    needsCeo(db, plan)
    return 'blocked_on_ceo'
  }
  if (outcome.outcome !== 'refuse') {
    proved(db, root, plan, step)
    if (last(step.step)) { finish(db, plan); return 'done' }
    advance(db, plan, step.step + 1)
    return 'running'
  }
  put(root, plan.id, 'refusal.md', refusalText(step, outcome))
  return back(db, plan)
}

function refusalText(step: Step, outcome: Outcome): string {
  const spans = outcome.spans.length === 0 ? '  (none named)' : outcome.spans.map((s) => `  - ${s}`).join('\n')
  return `step ${String(step.step)} ${step.name} refused by ${step.runs}\n\n${outcome.note}\n\nspans:\n${spans}\n`
}
