import { recount } from '../checks/ratchet.ts'
import type { Db } from '../store/index.ts'
import { digestOf } from '../store/approvals.ts'
import { keep, last as lastMerge, lastReview, record as recordMerge } from '../store/merges.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import type { Step } from '../templates/pr-path.ts'
import { classify } from './delta.ts'
import type { Outcome } from './kind.ts'
import { headOf, opened } from './push.ts'
import { mapOf } from './steps.ts'
import { abortMerge, behindMain, cloned, commitMerge, conflicted, diffOf, diffSince, fetchMain, get, holds, maybe, merging, mergeMain, narrowing,
  put, recut, srcDir, theirs, unmerged } from './workspace.ts'

/**
 * Step 3's base, one tick before the ready and batch gates: a merge returns no outcome,
 * so the rails judge the merged tree in this same tick, and it spends none of the `base.merged`
 * budget those two count their one miss against. A conflict outside the ratchet files is the builder's to settle, so the
 * refusal names the unmerged paths and rewinds onto the build. A tick that stopped inside a merge
 * left that merge open, and its bytes were committed before it, so the abort loses nothing and this
 * tick merges again from the old base. The rewind alone would hand the builder that same old
 * base, so the checkout is cut again from main and the builder's diff carried across to be re-applied.
 */
export function freshBase(db: Db, root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src) || shown(db, plan)) return null
  if (conflicted(src)) abortMerge(src)
  const main = fetchMain(src)
  if (!behindMain(src, main)) return null
  const paths = takeMain(db, root, plan, src, main, mapOf(plan.template).at(plan.step).step)
  if (paths === null) return null
  recut(root, plan.id)
  return { outcome: 'refuse', spans: paths, note: 'main moved and the branch conflicts with it; cut again from main', rewind: 2, moved: true }
}

/**
 * The one merge, for step 3 and for the ready and batch gates. Every merge leaves its two file
 * sets and their overlap on the plan, whether it went through or conflicted; `kept()` is the decision
 * that reads them. The builder's work is committed
 * first: a merge into a dirty tree is the one way main's bytes and the seat's could be lost against
 * each other -- and never over unmerged paths, or conflict markers are what the plan's bytes turn
 * out to be. A merge that cannot be made leaves the branch on its old base and answers with the
 * paths it stopped on.
 */
function takeMain(db: Db, root: string, plan: PlanRow, src: string, main: string, step: number): string[] | null {
  if (conflicted(src)) return unmerged(src)
  headOf(root, plan.id)
  const { incoming, mine } = merging(src, get(root, plan.id, 'base.sha').trim(), main)
  const overlap = incoming.some((path) => mine.includes(path))
  try {
    mergeMain(src)
  } catch {
    const paths = unmerged(src)
    if (paths.length === 0 || paths.some((path) => path !== 'ratchet.json' && !path.endsWith('/ratchet.json'))) {
      abortMerge(src)
      recordMerge(db, plan.id, step, { main, incoming, mine, overlap, clean: false })
      return paths
    }
    for (const path of paths) theirs(src, path)
    commitMerge(src, recount(src, [...incoming, ...mine]))
  }
  recordMerge(db, plan.id, step, { main, incoming, mine, overlap, clean: true })
  put(root, plan.id, 'base.sha', `${main}\n`)
  return null
}

export function kept(db: Db, root: string, plan: PlanRow, step: Step): Outcome | null {
  return merged(db, root, plan, step) ?? (step.step === 5 ? skipped(db, root, plan.id) : null)
}

/** A rework whose delta since senior's pass is comments or docs alone keeps that pass. */
function skipped(db: Db, root: string, plan: number): Outcome | null {
  const given = lastReview(db, plan, 'senior_review')
  const passed = maybe(root, plan, 'step-5.passed.diff')
  const src = srcDir(root, plan)
  if (given?.outcome !== 'pass' || given.tree === null || passed === null || !holds(src, given.tree)) return null
  const changed = narrowing(src, given.tree, get(root, plan, 'base.sha').trim()).changed
  const { mode, why } = classify(passed, diffSince(src, given.tree), changed)
  if (mode !== 'comment') return null
  keep(db, plan, 5, 'senior_review', given, null)
  put(root, plan, 'step-5.mode', `skipped: ${why}\n`)
  return { outcome: 'pass', spans: [], note: `senior_review skipped: ${why}` }
}

/**
 * A merge git took without help, that brought in no file the job changed, leaves the job's own diff
 * byte-identical: the reviewers already passed exactly these bytes, so their verdict stands and no seat is
 * fired. The rails and checks still run on the merged tree at step 3. Kept only for a verdict given before
 * that merge, and only while the diff is the one senior passed; anything else is a full review as before.
 */
function merged(db: Db, root: string, plan: PlanRow, step: Step): Outcome | null {
  const gate = step.verdict_gate
  const merge = lastMerge(db, plan.id)
  if (gate === null || merge === null || !merge.clean || merge.overlap || merge.verdict === null) return null
  const given = lastReview(db, plan.id, gate)
  if (given?.outcome !== 'pass' || given.id > merge.verdict) return null
  if (passedDiff(db, plan.id) !== digestOf(diffOf(root, plan.id))) return null
  keep(db, plan.id, step.step, gate, given, merge.id)
  return { outcome: 'pass', spans: [], note: `${step.runs} kept: main brought in ${String(merge.incoming.length)} file(s), none of the job's` }
}

/** The diff senior last passed, off the row its pass wrote. */
function passedDiff(db: Db, plan: number): string | null {
  const row = db.prepare("SELECT diff_digest FROM deliverables WHERE plan_id = ? AND step = 5 ORDER BY id DESC LIMIT 1")
    .get(plan) as { diff_digest: string } | undefined
  return row?.diff_digest ?? null
}

/**
 * Nothing lands over a moved main. The first miss merges main into the branch and sends the plan back
 * to the rails, which judge the merged bytes. A later miss, a conflict, or a tree left mid-merge goes
 * back to the rails, where `freshBase` merges main or, on a conflict, cuts the checkout again and carries the build across.
 */
export function baseMoved(db: Db, root: string, plan: PlanRow): Outcome | null {
  const src = srcDir(root, plan.id)
  if (!cloned(src) || shown(db, plan)) return null
  if (conflicted(src)) return toRails(root, plan, 'base:conflict', 'the checkout has unmerged paths from a tick that stopped mid-merge')
  const main = fetchMain(src)
  if (!behindMain(src, main)) return null
  if (maybe(root, plan.id, 'base.merged') !== null) return toRails(root, plan, 'base:stale', 'main moved again')
  if (takeMain(db, root, plan, src, main, mapOf(plan.template).at(plan.step).step) !== null) return toRails(root, plan, 'base:conflict', 'the branch conflicts with main')
  put(root, plan.id, 'base.merged', `${main}\n`)
  return { outcome: 'pass', spans: ['base:stale'], note: 'main moved; merged it and re-ran the rails', rewind: 3 }
}

/** Past this many trips back to the rails, a job that never catches main goes to a person. */
export const LAPS = 4

const LAPPED = 'base.laps'

function toRails(root: string, plan: PlanRow, span: 'base:stale' | 'base:conflict', note: string): Outcome {
  const laps = maybe(root, plan.id, LAPPED) ?? ''
  if (laps.split('\n').filter((l) => l !== '').length >= LAPS) {
    return { outcome: 'refuse', spans: [span], note: `${note}, and ${String(LAPS)} trips back to the rails have not caught main up` }
  }
  put(root, plan.id, LAPPED, `${laps}${span}\n`)
  return { outcome: 'pass', spans: [span], note: `${note}; back to the rails to take main`, rewind: 3 }
}

/** A stranger's pull request that is already open is not merged into: their main moving is theirs to settle. */
function shown(db: Db, plan: PlanRow): boolean {
  return !internal(plan) && opened(db, plan.id) !== null
}
