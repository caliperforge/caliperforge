import type { Read } from '../cli/gh.ts'
import { vetted } from '../cli/queue.ts'
import type { Provider } from '../providers/kind.ts'
import { digestOf } from '../store/approvals.ts'
import { hold } from '../store/holds.ts'
import { logged, newestRun, runSince } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { Taken } from '../store/leases.ts'
import { busy } from '../store/now.ts'
import { advance, back, end, finish, internal, needsCeo, rewind, type PipeRow, type PlanRow, waiting } from '../store/plans.ts'
import { blipped, builds, peer, refused } from '../store/refusals.ts'
import { draft, grow, review } from '../templates/comms.ts'
import { builder, type Step } from '../templates/pr-path.ts'
import { answered, check, gather } from '../templates/research.ts'
import type { Fired, Outcome } from './kind.ts'
import { parted } from './split.ts'
import { executed } from './command.ts'
import { subject } from './daily.ts'
import { refilled } from './refill.ts'
import type { Wire } from './push.ts'
import { fireBrief, fireLanded, fireSeat } from './seat.ts'
import { proved } from './ready.ts'
import { kernel, mapOf, targetOf } from './steps.ts'
import { kept } from './merge.ts'
import { languageFor } from './route.ts'
import { branchOf, checkout, diffOf, internalBranch, maybe, put, ruled, srcDir, titleOf } from './workspace.ts'
import { assembling, assembly, homeOf } from './home.ts'
import { BUILDS, capped, fingerprintOf, refusalText, stopped, streak, STREAK } from './refusal.ts'

/** CI that failed, waited or never showed is GitHub's state, not a fault on main: it never switches a lane off. */
export const CI_ONLY = /^(?:checks:CI|.* ci\.(?:red|pending|missing))$/

/** `wait` is a step that settled by waiting: a CI still running, or a checkout the network failed. Neither is worth asking again in the same tick. */
export async function stepped(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken,
  provider: Provider, wire?: Wire, read?: Read): Promise<{ fired: Fired; wait: boolean }> {
  const cap = overBuilt(db, root, pipe, plan, lease)
  if (cap !== null) return { fired: cap, wait: false }
  const tree = workspace(db, root, plan)
  const step = mapOf(plan.template).at(plan.step, tree.language)
  const mark = newestRun(db)
  const verdicts = newestVerdict(db)
  const outcome = tree.failed ?? seatless(plan, step, tree.language) ?? await made(db, root, plan, step, provider, wire, read)
  const state = settle(db, root, plan, step, outcome)
  if (outcome.quiet !== true) {
    logged(db, { plan: plan.id, kind: step.name, actor: step.runs, outcome: outcome.outcome === 'needs_ceo' ? 'escalate' : outcome.outcome, message: outcome.note,
      pointer: pointer(db, plan.id, step, verdicts), run: runSince(db, plan.id, step.step, mark) })
  }
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

function seatless(plan: PlanRow, step: Step, language: string | null): Outcome | null {
  if (plan.template !== 'pr_path' || step.fires !== 'seat' || builder(language) !== null) return null
  return { outcome: 'needs_ceo', spans: ['staffing'], note: `no ${String(language)} ${String(step.mode)} seat` }
}

function newestVerdict(db: Db): number {
  return (db.prepare('SELECT coalesce(max(id), 0) AS id FROM verdicts').get() as { id: number }).id
}

function pointer(db: Db, plan: number, step: Step, after: number): string {
  if (step.fires === 'brief') return `plans:${String(plan)}`
  const own = step.fires === 'review'
    ? (db.prepare(`SELECT max(id) AS id FROM verdicts
        WHERE plan = ? AND step = ? AND kind = 'review' AND id > ?`)
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
  needsCeo(db, plan, note)
  waiting(db, [{ plan: plan.id, why: 'token_ceiling' }])
  const step = mapOf(plan.template).at(plan.step)
  logged(db, { plan: plan.id, kind: step.name, actor: 'token_ceiling', outcome: 'refuse', message: note,
    pointer: `step-${String(step.step)}`, run: null })
  return { pipe: pipe.name, plan: plan.id, step: step.step, name: step.name, outcome: 'refuse',
    state: 'blocked_on_ceo', spans: ['ceiling'], note, stole: lease.stole }
}

/** A pr_path plan that has run `BUILDS` builds stops before the next, with every reason it was refused in director.md. */
function overBuilt(db: Db, root: string, pipe: PipeRow, plan: PlanRow, lease: Taken): Fired | null {
  const n = builds(db, plan.id)
  if (plan.template !== 'pr_path' || plan.step !== BUILD || n < BUILDS) return null
  const note = capped(db, root, plan.id, `${String(n)} builds ran; the next waits for the director`)
  needsCeo(db, plan, note)
  return { pipe: pipe.name, plan: plan.id, step: BUILD, name: 'build', outcome: 'refuse',
    state: 'blocked_on_ceo', spans: ['build_cap'], note, stole: lease.stole }
}

/**
 * The checkout the plan's seats read and write. A plan parked on a cold pulse or still
 * waiting on `cf approve target` never earns one, so it is made on the first step that
 * needs a tree — step 1, where the brief is written against the code — and not at queue
 * time; the language it turns out to be written in is what picks the builder.
 */
function workspace(db: Db, root: string, plan: PlanRow): { language: string | null; failed: Outcome | null } {
  const fires = mapOf(plan.template).at(plan.step).fires
  const tree = plan.template !== 'comms' && (fires === 'brief' || fires === 'seat' || fires === 'review') ? treeOf(db, root, plan) : null
  if (tree === null) return { language: null, failed: null }
  try {
    checkout(root, plan.id, tree.repo, tree.branch, tree.from)
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error)
    if (OFFLINE.test(note)) return { language: null, failed: thrown(mapOf(plan.template).at(plan.step), note) }
    return { language: null, failed: { outcome: 'refuse', spans: [tree.repo], note: `checkout: ${note}`, blip: true } }
  }
  return { language: languageFor(db, plan, srcDir(root, plan.id)), failed: null }
}

/**
 * Which repository the branch is cut in and what it is called: a stranger's repo and
 * `<repo>-<issue>[-<part>]-a<attempt>` for a target, or `asm/<plan>` once its parts have landed, our own repo and `p<plan>-<slug>` for an issue
 * of ours, the target's repo and `p<plan>-<slug>` for a part of an outside plan. Every way the clone is
 * our fork and the base is that repo's `main`, or our fork's `asm/<parent>` for a part.
 */
function treeOf(db: Db, root: string, plan: PlanRow): { repo: string; branch: string; from?: string | undefined } | null {
  if (internal(plan)) {
    const branch = internalBranch(plan.id, titleOf(root, plan.id) ?? `plan ${String(plan.id)}`)
    const outside = targetOf(db, plan)
    return outside === null ? { repo: homeOf(plan), branch } : { repo: outside.repo, branch, from: assembly(db, plan)?.branch }
  }
  const row = targetOf(db, plan)
  return row === null ? null : { repo: row.repo, branch: assembling(db, plan) ?? branchOf(row.repo, row.issue_no, plan.retries + 1, row.part) }
}

/** The first line goes in the span: two plans that threw differently must not match as `shared` and turn the lane off. */
async function made(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire, read?: Read): Promise<Outcome> {
  try {
    const out = await fire(db, root, plan, step, provider, wire, read)
    if (out.command !== undefined) return executed(db, root, plan, out.command)
    return out.parts === undefined ? out : parted(db, root, plan, out.parts, wire)
  } catch (error) {
    return thrown(step, error instanceof Error ? error.message : String(error))
  }
}

/** A throw that says the host lost its network is not the job's fault: it holds the job on its step, uncounted, and the next tick tries again. */
const OFFLINE = /Could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|Network is unreachable|Failed to connect to|Connection timed out/

export function thrown(step: Step, message: string): Outcome {
  if (OFFLINE.test(message)) {
    return { outcome: 'pass', held: true, spans: ['offline'], note: `step ${String(step.step)} ${step.name}: the network is down; the next tick tries again` }
  }
  return { outcome: 'refuse', spans: [`threw: ${message.split('\n')[0] ?? ''}`],
    note: `step ${String(step.step)} ${step.name} threw`, message, to: step.step }
}

function fire(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider, wire?: Wire, read?: Read): Promise<Outcome> {
  if (step.fires === 'brief') {
    const says = plan.target_id !== null && wire?.intake !== undefined ? vetted(db, root, plan.id, plan.target_id, wire.intake) : null
    if (says !== null) return Promise.resolve({ outcome: 'needs_ceo', spans: ['their work'], note: says })
    refilled(db, root, plan, wire)
    return model(db, plan, step, () => fireBrief(db, root, plan, step, provider))
  }
  if (step.fires === 'seat') {
    return model(db, plan, step, () => plan.template === 'pr_path' ? fireSeat(db, root, plan, step, provider) : seated(plan, step)(db, root, plan, step, provider))
  }
  if (step.fires === 'review') {
    const standing = kept(db, root, plan, step)
    return standing === null ? model(db, plan, step, () => fireLanded(db, root, plan, step, provider)) : Promise.resolve(standing)
  }
  if (step.name === 'check') return check(root, plan)
  return Promise.resolve(kernel(db, root, plan, wire, read))
}

const SEATS: Partial<Record<PlanRow['template'], Record<string, typeof grow>>> = {
  comms: { draft, text_review: review, grow },
  research: { gather, review: answered },
}

function seated(plan: PlanRow, step: Step): typeof grow {
  const handler = SEATS[plan.template]?.[step.name]
  if (handler === undefined) throw new Error(`${plan.template} has no handler for seat step ${step.name}`)
  return handler
}

function model(db: Db, plan: PlanRow, step: Step, run: () => Promise<Outcome>): Promise<Outcome> {
  busy(db, plan.id, 'model', `${step.runs} step ${String(step.step)}`)
  return run()
}

function settle(db: Db, root: string, plan: PlanRow, step: Step, outcome: Outcome): string {
  if (outcome.held === true) return 'running'
  if (outcome.blip === true) return blip(db, root, plan, step, outcome)
  if (outcome.split === true || outcome.ran === true) {
    end(db, plan.id, 'done')
    return 'done'
  }
  if (outcome.outcome === 'refuse') put(root, plan.id, 'refusal.md', refusalText(step, outcome))
  if (outcome.rewind !== undefined && outcome.outcome !== 'refuse') {
    rewind(db, plan.id, outcome.rewind)
    return 'running'
  }
  if (outcome.outcome === 'needs_ceo') {
    needsCeo(db, plan, outcome.note)
    return 'blocked_on_ceo'
  }
  if (outcome.outcome !== 'refuse') {
    return db.transaction((): string => {
      proved(db, root, plan, step)
      if (mapOf(plan.template).last(step.step)) { finish(db, plan); return 'done' }
      advance(db, plan, step.step + 1)
      return plan.template === 'pr_path' ? hold(db, plan.id, step.step) : 'running'
    })()
  }
  const r = { plan: plan.id, step: step.step, fingerprint: fingerprintOf(step, outcome),
    diff: step.step >= 3 ? digestOf(plan.template === 'comms' ? subject(root, plan.id)[1] ?? '' : diffOf(root, plan.id)) : null, moved: outcome.moved,
    own: outcome.spans.some((s) => s.startsWith('ratchet:')) || undefined, span: outcome.spans.join(', '), note: outcome.note,
    ticket: digestOf(`${maybe(root, plan.id, 'issue.md') ?? ''}${ruled(root, plan.id) ?? ''}${maybe(root, plan.id, 'rulings.md') ?? ''}`) }
  const why = refused(db, r)
  const cap = streaked(db, root, plan, step)
  if (why !== 'again') stopped(root, plan.id, why)
  if (why === 'shared' && !outcome.spans.every((s) => CI_ONLY.test(s))) {
    db.prepare('UPDATE pipes SET enabled = 0 WHERE id = ?').run(plan.pipe_id)
    outcome.note += `; lane off: plans ${String(plan.id)} and ${String(peer(db, r))} refused on ${outcome.spans.join(', ')}`
    logged(db, { plan: plan.id, kind: 'pipe', actor: 'settle', outcome: 'escalate', message: outcome.note, pointer: null, run: null })
  }
  // A rewind costs no retry but is recorded like any refusal, so a second identical one waits for a person.
  if (outcome.rewind !== undefined && why === 'again' && cap === null) { rewind(db, plan.id, outcome.rewind); return 'running' }
  return back(db, plan, outcome.to ?? backTo(step), cap !== null || why !== 'again' || fenced(outcome), cap ?? outcome.note)
}

/** The note a `STREAK`th refusal in a row from one rail or reviewer past the build stops a pr_path plan with, or null. */
function streaked(db: Db, root: string, plan: PlanRow, step: Step): string | null {
  const run = plan.template === 'pr_path' && step.step > BUILD ? streak(db, plan.id) : null
  return run === null || run.n < STREAK ? null : capped(db, root, plan.id, `${run.source} refused it ${String(run.n)} times in a row`)
}

function fenced(outcome: Outcome): boolean {
  return outcome.spans.length > 0 && outcome.spans.every((s) => / authority\.(?:outside_files|write_paths)$/.test(s))
}

/** Step 2 is the build in templates/pr-path.ts. */
const BUILD = 2

/** Where a refusal sends the job: a review's and a build's to the build, a kernel step's to the step before it. */
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
  needsCeo(db, plan, outcome.note)
  return 'blocked_on_ceo'
}
