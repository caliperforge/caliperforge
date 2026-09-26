import { join } from 'node:path'
import { fill } from '../cli/digests.ts'
import { authority } from '../rails/authority/index.ts'
import { checked } from '../rails/checks/index.ts'
import { parse } from '../rails/diff.ts'
import { audit, record } from '../rails/completion-audit/index.ts'
import { identifiers } from '../rails/identifiers/index.ts'
import { record as recordRail, type Verdict } from '../rails/record.ts'
import { scan } from '../rails/secret-scan/index.ts'
import { weakened } from '../rails/test-weakened/index.ts'
import { sources, tight } from '../rails/tight/index.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { BUILT, internal, type PlanRow } from '../store/plans.ts'
import { builder } from '../templates/pr-path.ts'
import { checks, mode, type Failure } from './checks.ts'
import { ciChecks } from './ci.ts'
import { outsideLanguage } from './gates.ts'
import type { Outcome } from './kind.ts'
import { lock, unlock } from './lock.ts'
import { seat } from '../runner/rules.ts'
import { renumbered, strays } from './fence.ts'
import { fenceFor, languageFor } from './route.ts'
import { diffOf, doneIds, get, maybe, srcDir } from './workspace.ts'
import { kernelPlan } from './home.ts'
import type { Wire } from './push.ts'

/**
 * Step 3: the six rails the map's step list names, in its order, ending at the first refusal, and
 * then the checkout's own type check, style check and tests. No reviewer tokens. The fill comes
 * first so that `rest()` reads a diff carrying the digests, not the ones the builder left behind.
 * Our own repo's suite runs on GitHub CI when `checks.where` says so (#332), and on this laptop otherwise.
 */
export function preReview(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const refusal = kernelPlan(plan) ? unfilled(srcDir(root, plan.id)) : null
  if (refusal !== null) return refusal
  const handback = get(root, plan.id, 'step-2.handback.md')
  const diff = diffOf(root, plan.id)
  const prev = maybe(root, plan.id, 'step-2.handback.prev.md') ?? ''
  const first = audit(handback, doneIds(get(root, plan.id, 'issue.md')), prev, diff)
  record(db, plan.id, first, 0)
  if (first.outcome !== 'pass') return named('completion-audit', first)
  for (const [rail, run] of rest(db, root, plan, handback, diff)) {
    const verdict = run()
    recordRail(db, join(root, 'rails', rail), plan.id, verdict, 0)
    if (verdict.outcome !== 'pass') return named(rail, verdict)
  }
  // a stranger's npm scripts never run on this host. A stranger's repo in a language with its own seat runs that
  // language's gates (#204): its builder already ran them at step 2, and a red fork CI after the reviews costs more.
  const outside = internal(plan) ? null : outsideLanguage(languageFor(db, plan, srcDir(root, plan.id)))
  const ci = internal(plan) ? ciChecks(db, root, plan, wire) : null
  if (ci !== null && 'wait' in ci) return ci.wait
  if (ci !== null) {
    recordRail(db, join(root, 'rails', 'checks'), plan.id, checked(ci.failed, diffOf(root, plan.id)), 0)
    if (ci.failed !== null) return broke(ci.failed)
    return { outcome: 'pass', spans: [], note: `pre-review: six rails pass; checks ran on GitHub CI at ${ci.at}` }
  }
  if (internal(plan) || outside !== null) {
    const holder = lock(root, plan.id)
    if (holder !== null) return { outcome: 'pass', held: true, spans: ['checks'], note: `checks wait: plan ${String(holder.plan)} is running its tests` }
    try {
      const failed = checks(srcDir(root, plan.id), undefined, outside === null ? narrow(db, plan) : [],
        outside === null ? null : { language: outside, files: filesOf(db, plan.id).map((f) => f.path) })
      recordRail(db, join(root, 'rails', 'checks'), plan.id, checked(failed, diffOf(root, plan.id)), 0)
      if (failed !== null) return broke(failed)
    } finally {
      unlock(root, plan.id)
    }
  }
  const ran = internal(plan) ? mode(srcDir(root, plan.id)) : outside ?? 'none'
  return { outcome: 'pass', spans: [], note: `pre-review: six rails pass; checks ran ${ran}` }
}

/**
 * #77. The first build's lap runs the whole suite, so every job is judged against it once, on the tree it
 * built on. A rebuild only touched the plan's own files, so its lap runs the tests those files reach and
 * the suite is not paid for again -- the cost is in the laps after the first: plan 62 went round 25 times.
 * A rebuild with no recorded file list gets the whole suite, which is the safe way to know nothing.
 */
export function narrow(db: Db, plan: PlanRow): string[] {
  const built = db.prepare(`SELECT count(*) AS n FROM runs WHERE plan = ? AND step = 2 AND ${BUILT}`).get(plan.id) as { n: number }
  return built.n > 1 ? filesOf(db, plan.id).map((f) => f.path) : []
}

/** The roster and seat files a fill reads are the builder's, so their typo refuses this plan where a throw takes the lap. */
function unfilled(src: string): Outcome | null {
  try {
    fill(src, new Date().toISOString().slice(0, 10))
    return null
  } catch (error) {
    return {
      outcome: 'refuse',
      spans: ['rules/roster.yaml'],
      note: 'digests: the checkout could not be filled',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function broke(failed: Failure): Outcome {
  return {
    outcome: 'refuse',
    spans: [`checks:${failed.script}`, ...failed.tests],
    note: `${failed.command} exit ${failed.code}${failed.retried ? ' after one retry' : ''}`,
    message: failed.output,
  }
}

/**
 * Tight's prose rule reads what the maintainer will read: the pull request text the card set, where it set one.
 * The handback is the machine's; judging its prose sent a builder after a PR body it may not write. A kernel
 * plan lands as a commit named for its branch and opens no pull request, so it has no prose to judge; an outside
 * plan's body is built from the brief, never the handback (plan 70).
 */
function rest(db: Db, root: string, plan: PlanRow, handback: string, diff: string): [string, () => Verdict][] {
  const src = srcDir(root, plan.id)
  const name = builder(languageFor(db, plan, src))
  const fence = fenceFor(db, plan.id, seat(root, name).manifest.write_paths)
  const outside = kernelPlan(plan)
    ? strays(parse(diff).map((f) => f.path), filesOf(db, plan.id).map((f) => f.path), handback)
    : []
  return [
    ['secret-scan', () => scan(diff)],
    ['authority', () => authority(root, name, diff, kernelPlan(plan), fence, outside, kernelPlan(plan) ? renumbered(src, diff) : [])],
    ['tight', () => tight(root, { diff, sources: sources(src, diff), ...prose(root, plan), code: internal(plan) })],
    ['test-weakened', () => weakened(diff, 'green', [maybe(root, plan.id, 'ask.md') ?? '', get(root, plan.id, 'issue.md'), prose(root, plan).description].join('\n'))],
    ['identifiers', () => identifiers(src, handback)],
  ]
}

function prose(root: string, plan: PlanRow): { description: string } {
  return { description: maybe(root, plan.id, 'pr.md') ?? '' }
}

function named(rail: string, verdict: Verdict): Outcome {
  return { outcome: verdict.outcome, spans: verdict.spans, note: `${rail}: ${verdict.message}` }
}
