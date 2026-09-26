import type { Read } from '../cli/gh.ts'
import type { Provider } from '../providers/kind.ts'
import { digestOf } from '../store/approvals.ts'
import { hold } from '../store/holds.ts'
import { logged, newestRun, runSince } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Taken } from '../store/leases.ts'
import { busy } from '../store/now.ts'
import { advance, back, finish, internal, needsCeo, rewind, type PipeRow, type PlanRow, waiting } from '../store/plans.ts'
import { blipped, refused } from '../store/refusals.ts'
import { at, last, type Step } from '../templates/pr-path.ts'
import type { Fired, Outcome } from './kind.ts'
import { parted } from './split.ts'
import type { Wire } from './push.ts'
import { fireRound } from './quick.ts'
import { fireBrief, fireSeat } from './seat.ts'
import { kept, kernel, proved, targetOf } from './steps.ts'
import { languageFor } from './route.ts'
import { branchOf, checkout, diffOf, internalBranch, maybe, put, srcDir, titleOf } from './workspace.ts'
import { homeOf } from './home.ts'
import { fingerprintOf, refusalText, stopped } from './refusal.ts'

/** `wait` is a step that settled by waiting: a CI still running, or a checkout the network failed. Neither is worth asking again in the same tick. */
export async function stepped(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken,
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
export function ceilinged(db: Db, root: string, pipe: PipeRow, plan: PlanRow, over: { spent: number; ceiling: number },
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
    diff: step.step >= 3 ? digestOf(diffOf(root, plan.id)) : null, moved: outcome.moved,
    own: outcome.spans.some((s) => s.startsWith('ratchet:')) || undefined })
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
