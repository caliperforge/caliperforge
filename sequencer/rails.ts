import { join } from 'node:path'
import { fill } from '../cli/digests.ts'
import { authority } from '../rails/authority/index.ts'
import { parse } from '../rails/diff.ts'
import { audit, record } from '../rails/completion-audit/index.ts'
import { identifiers } from '../rails/identifiers/index.ts'
import { record as recordRail, type Verdict } from '../rails/record.ts'
import { scan } from '../rails/secret-scan/index.ts'
import { weakened } from '../rails/test-weakened/index.ts'
import { sources, tight } from '../rails/tight/index.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { builder } from '../templates/pr-path.ts'
import { checks, type Failure } from './checks.ts'
import type { Outcome } from './kind.ts'
import { seat } from '../runner/rules.ts'
import { strays } from './fence.ts'
import { fenceFor, languageFor } from './route.ts'
import { diffOf, doneIds, get, maybe, srcDir } from './workspace.ts'

/**
 * Step 3: the six rails the map's step list names, in its order, ending at the first refusal, and
 * then the checkout's own type check, style check and tests. No reviewer tokens. The fill comes
 * first so that `rest()` reads a diff carrying the digests, not the ones the builder left behind.
 */
export function preReview(db: Db, root: string, plan: PlanRow): Outcome {
  const refusal = internal(plan) ? unfilled(srcDir(root, plan.id)) : null
  if (refusal !== null) return refusal
  const handback = get(root, plan.id, 'step-2.handback.md')
  const first = audit(handback, doneIds(get(root, plan.id, 'issue.md')))
  record(db, plan.id, first, 0)
  if (first.outcome !== 'pass') return named('completion-audit', first)
  for (const [rail, run] of rest(db, root, plan, handback)) {
    const verdict = run()
    recordRail(db, join(root, 'rails', rail), plan.id, verdict, 0)
    if (verdict.outcome !== 'pass') return named(rail, verdict)
  }
  // a stranger's scripts and install hooks never run on this host; their fork CI at step 6 is their check
  const failed = internal(plan) ? checks(srcDir(root, plan.id)) : null
  if (failed !== null) return broke(failed)
  return { outcome: 'pass', spans: [], note: 'pre-review: six rails pass' }
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
    spans: [`checks:${failed.command.split(' ').at(-1) ?? ''}`],
    note: `${failed.command} exit ${String(failed.code)}${failed.retried ? ' after one retry' : ''}`,
    message: failed.output,
  }
}

/**
 * Tight's prose rule reads what the maintainer will read: the pull request text the card set, where it set one.
 * The handback is the machine's; judging its prose sent a builder after a PR body it may not write.
 */
function rest(db: Db, root: string, plan: PlanRow, handback: string): [string, () => Verdict][] {
  const src = srcDir(root, plan.id)
  const diff = diffOf(root, plan.id)
  const name = builder(languageFor(db, plan, src))
  const fence = fenceFor(db, plan.id, seat(root, name).manifest.write_paths)
  const outside = internal(plan)
    ? strays(parse(diff).map((f) => f.path), filesOf(db, plan.id).map((f) => f.path), handback)
    : []
  return [
    ['secret-scan', () => scan(diff)],
    ['authority', () => authority(root, name, diff, internal(plan), fence, outside)],
    ['tight', () => tight(root, { diff, sources: sources(src, diff), description: maybe(root, plan.id, 'pr.md') ?? handback })],
    ['test-weakened', () => weakened(diff, 'green')],
    ['identifiers', () => identifiers(src, handback)],
  ]
}

function named(rail: string, verdict: Verdict): Outcome {
  return { outcome: verdict.outcome, spans: verdict.spans, note: `${rail}: ${verdict.message}` }
}
