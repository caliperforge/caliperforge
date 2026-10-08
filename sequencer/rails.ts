import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ratcheted } from '../checks/ratchet.ts'
import { fill, ROSTER } from '../cli/digests.ts'
import { record as inbox, ticketOf } from '../cli/inbox.ts'
import { authority } from '../rails/authority/index.ts'
import { checked } from '../rails/checks/index.ts'
import { parse } from '../rails/diff.ts'
import { audit, record, undone } from '../rails/completion-audit/index.ts'
import { identifiers } from '../rails/identifiers/index.ts'
import { record as recordRail, type Verdict } from '../rails/record.ts'
import { scan } from '../rails/secret-scan/index.ts'
import { weakened } from '../rails/test-weakened/index.ts'
import { sources, tight } from '../rails/tight/index.ts'
import { logged } from '../store/events.ts'
import { filesOf, listed } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { digestOf } from '../store/approvals.ts'
import { ratchetRules } from '../store/lanes.ts'
import { busy } from '../store/now.ts'
import { BUILT, laneOff, type PlanRow } from '../store/plans.ts'
import { profile, type Profile } from '../store/profile.ts'
import { builder } from '../templates/pr-path.ts'
import { checks, mode, npm, type Commands, type Failure, type Run } from './checks.ts'
import { ciChecks } from './ci.ts'
import { outsideLanguage } from './gates.ts'
import type { Outcome } from './kind.ts'
import { lock, unlock } from './lock.ts'
import { seat } from '../runner/rules.ts'
import { broken, renumbered, strays } from './fence.ts'
import { fenceFor, languageFor } from './route.ts'
import { diffOf, doneIds, get, maybe, put, srcDir } from './workspace.ts'
import type { Wire } from './push.ts'
import { repoOf } from './ready.ts'

type Rails = Profile['rails']

/**
 * Step 3: the six rails the map's step list names, in its order, ending at the first refusal, and
 * then the checkout's own type check, style check and tests. No reviewer tokens. The fill comes
 * first so that `rest()` reads a diff carrying the digests, not the ones the builder left behind.
 * Our own repo's suite runs on GitHub CI when `checks.where` says so, and on this laptop otherwise.
 */
export function preReview(db: Db, root: string, plan: PlanRow, wire?: Wire): Outcome {
  const repo = repoOf(db, plan)
  const read = repo === null ? null : profile(root, repo)
  const on = read?.rails
  const commands = read?.commands ?? {}
  const refusal = on?.digests === true ? unfilled(srcDir(root, plan.id)) : null
  if (refusal !== null) return refusal
  const handback = get(root, plan.id, 'step-2.handback.md')
  const diff = diffOf(root, plan.id)
  const stop = undone(handback, judged(root, plan.id, diff))
  if (stop.outcome !== 'pass') {
    record(db, plan.id, stop, 0)
    return { outcome: 'needs_ceo', spans: stop.spans, note: `completion-audit: ${stop.message}` }
  }
  const prev = maybe(root, plan.id, 'step-2.handback.prev.md') ?? ''
  const ids = [...(maybe(root, plan.id, 'findings.md') ?? '').matchAll(/^- (G\d+) /gm)].map((m) => m[1] ?? '')
  const first = audit(handback, [...doneIds(get(root, plan.id, 'issue.md')), ...ids], prev, diff)
  record(db, plan.id, first, 0)
  if (first.outcome !== 'pass') return unfinishedFirst(root, plan.id, named('completion-audit', first))
  for (const [rail, run] of rest(db, root, plan, handback, diff, on)) {
    const verdict = run()
    recordRail(db, join(root, 'rails', rail), plan.id, verdict, 0)
    if (verdict.outcome !== 'pass') return named(rail, verdict)
  }
  return on?.ratchet === true ? ratchetFirst(db, root, plan, diff, on, commands, wire) : suite(db, root, plan, on, commands, wire)
}

/** `step-3.judged` holds the last lap's diff and rulings.md digests: the diff standing still under a new ruling is unmoved. */
function judged(root: string, plan: number, diff: string): boolean {
  const rulings = maybe(root, plan, 'rulings.md')
  const now = [digestOf(diff), rulings === null ? '' : digestOf(rulings)]
  const last = maybe(root, plan, 'step-3.judged')?.split('\n')
  put(root, plan, 'step-3.judged', now.join('\n'))
  return last !== undefined && last[0] === now[0] && last[1] !== now[1]
}

/** Only findings on paths the diff touches are the job's: the rest is main's debt. A held step comes round again, so it warns once not held. */
function ratchetFirst(db: Db, root: string, plan: PlanRow, diff: string, on: Rails, commands: Commands, wire?: Wire): Outcome {
  const { mode: set, raises } = ratchetRules(db)
  const touched = new Set(parse(diff).map((f) => f.path))
  const found = ratcheted(srcDir(root, plan.id), raises).filter((f) => touched.has(f.path))
  const message = found.map((f) => f.message).join('; ')
  if (found.length > 0 && set === 'refuse') return { outcome: 'refuse', spans: found.map((f) => `ratchet:${f.path}`), note: 'ratchet: the job grew a file past its budget', message }
  const outcome = suite(db, root, plan, on, commands, wire)
  if (found.length > 0 && outcome.held !== true) logged(db, { plan: plan.id, kind: 'ratchet', actor: 'ratchet', outcome: 'pass', message: `would refuse: ${message}`, pointer: null, run: null })
  return outcome
}

function suite(db: Db, root: string, plan: PlanRow, on: Rails, commands: Commands, wire?: Wire): Outcome {
  // a stranger's npm scripts never run on this host. A stranger's repo in a language with its own seat runs that
  // language's gates: its builder already ran them at step 2, and a red fork CI after the reviews costs more.
  const local = on?.checks !== undefined
  const outside = local ? null : outsideLanguage(languageFor(db, plan, srcDir(root, plan.id), false))
  const ci = on?.checks === 'ci' ? ciChecks(db, root, plan, wire) : null
  if (ci !== null && 'wait' in ci) return ci.wait
  if (ci !== null) {
    recordRail(db, join(root, 'rails', 'checks'), plan.id, checked(ci.failed, diffOf(root, plan.id)), 0)
    if (ci.failed !== null) return broke(db, root, plan, ci.failed)
    return { outcome: 'pass', spans: [], note: `pre-review: six rails pass; checks ran on GitHub CI at ${ci.at}` }
  }
  if (local || outside !== null) {
    const holder = lock(root, plan.id)
    if (holder !== null) return { outcome: 'pass', held: true, spans: ['checks'], note: `checks wait: plan ${String(holder.plan)} is running its tests` }
    try {
      const diff = diffOf(root, plan.id)
      const failed = checks(srcDir(root, plan.id), commands, noted(db, plan.id), outside === null ? narrow(db, plan) : [],
        outside === null ? null : { language: outside, files: filesOf(db, plan.id).map((f) => f.path) },
        parse(diff).map((f) => f.path))
      if (failed?.fault !== undefined) return faulted(db, root, plan, failed.fault)
      if (failed?.capped === true) return capped(failed)
      recordRail(db, join(root, 'rails', 'checks'), plan.id, checked(failed, diff), 0)
      if (failed !== null) return broke(db, root, plan, failed)
    } finally {
      unlock(root, plan.id)
    }
  }
  const ran = local ? mode(srcDir(root, plan.id)) : outside ?? 'none'
  return { outcome: 'pass', spans: [], note: `pre-review: six rails pass; checks ran ${ran}` }
}

/** A Mac that cannot run tests holds the job with its retries and switches its lane off, with one inbox line. */
export function faulted(db: Db, root: string, plan: PlanRow, fault: string): Outcome {
  const name = laneOff(db, plan.pipe_id)
  const note = `Xcode on this Mac cannot run tests (${fault}): restart the Mac, or run xcodebuild -runFirstLaunch after an Xcode update, then cf pipe on ${name ?? 'its lane, already off'}`
  if (name !== null) inbox(root, [{ at: new Date().toISOString(), plan: plan.id, ticket: ticketOf(db, plan.id), kind: 'blocked', step: 3, name: 'rails', note }])
  return { outcome: 'pass', held: true, spans: ['xcode'], note }
}

/** A run the cap killed before any test went red is the gate's blip: it stays on step 3 until `BLIPS` in a row. */
export function capped(failed: Failure): Outcome {
  return { outcome: 'refuse', blip: true, spans: ['checks:cap'], note: `${failed.command} exit ${failed.code}: killed at the cap with no test red`, message: failed.output }
}

/**
 * The first build's lap runs the whole suite, so every job is judged against it once, on the tree it
 * built on. A rebuild only touched the plan's own files, so its lap runs the tests those files reach and
 * the suite is not paid for again.
 * A rebuild with no recorded file list gets the whole suite, which is the safe way to know nothing.
 */
export function narrow(db: Db, plan: PlanRow): string[] {
  const built = db.prepare(`SELECT count(*) AS n FROM runs WHERE plan = ? AND step = 2 AND ${BUILT}`).get(plan.id) as { n: number }
  return built.n > 1 ? filesOf(db, plan.id).map((f) => f.path) : []
}

function noted(db: Db, plan: number): Run {
  return (args, cwd, bin) => npm(args, cwd, bin, (doing, detail) => { busy(db, plan, doing, detail) })
}

/** The roster and seat files a fill reads are the builder's, so their typo refuses this plan where a throw takes the lap. */
function unfilled(src: string): Outcome | null {
  try {
    if (existsSync(join(src, 'cli/cf.ts'))) execFileSync('node', ['cli/cf.ts', 'digests'], { cwd: src, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    else fill(src, new Date().toISOString().slice(0, 10))
    return null
  } catch (error) {
    return {
      outcome: 'refuse',
      spans: [ROSTER],
      note: 'digests: the checkout could not be filled',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function broke(db: Db, root: string, plan: PlanRow, failed: Failure): Outcome {
  const added = broken(srcDir(root, plan.id), failed.tests, filesOf(db, plan.id).map((f) => f.path),
    parse(diffOf(root, plan.id)).map((f) => f.path))
  for (const path of added ?? []) listed(db, plan.id, path)
  return {
    outcome: 'refuse',
    spans: [`checks:${failed.script}`, ...failed.tests],
    note: `${failed.command} exit ${failed.code}${failed.retried ? ' after one retry' : ''}${added === null ? '' : `; added to this job's files: ${added.join(', ')}`}`,
    message: failed.output,
  }
}

/**
 * Step 3 judges no prose: pr.md is a person's or step 8's, out of the builder's reach, and step 8's prose check
 * flags it on the card.
 */
function strangers(db: Db, plan: PlanRow): boolean {
  if (plan.target_id === null) return false
  const row = db.prepare('SELECT repo FROM targets WHERE id = ?').get(plan.target_id) as { repo: string } | undefined
  return row !== undefined && !row.repo.startsWith('caliperforge/')
}

function rest(db: Db, root: string, plan: PlanRow, handback: string, diff: string, on: Rails): [string, () => Verdict][] {
  const src = srcDir(root, plan.id)
  const language = languageFor(db, plan, src)
  const name = builder(language)
  if (name === null) throw new Error(`no ${String(language)} build seat`)
  const fence = fenceFor(db, plan.id, seat(root, name).manifest.write_paths)
  const ours = on?.fence === true
  const outside = ours
    ? strays(parse(diff).map((f) => f.path), filesOf(db, plan.id).map((f) => f.path), handback, get(root, plan.id, 'issue.md'))
    : []
  const weakenedRail: [string, () => Verdict] = ['test-weakened', () => weakened(diff, 'green', [maybe(root, plan.id, 'ask.md') ?? '', get(root, plan.id, 'issue.md'), maybe(root, plan.id, 'rulings.md') ?? '', maybe(root, plan.id, 'pr.md') ?? ''].join('\n'))]
  const scope: [string, () => Verdict][] = [
    ['secret-scan', () => scan(diff)],
    ['authority', () => authority(root, name, diff, ours, fence, outside, ours ? renumbered(src, diff) : [])],
  ]
  // A stranger's repo is judged by its own CI and maintainers, not our house style rails.
  if (strangers(db, plan)) return [...scope, weakenedRail]
  return [
    ...scope,
    ['tight', () => tight(root, { diff, sources: sources(src, diff), description: '', code: on?.tight_code === true })],
    weakenedRail,
    ['identifiers', () => identifiers(src, handback, diff)],
  ]
}

function unfinishedFirst(root: string, plan: number, outcome: Outcome): Outcome {
  const command = maybe(root, plan, 'step-2.unfinished.md')
  return command === null ? outcome : { ...outcome, note: `the builder's test run did not finish: ${command.replace(/\s+/g, ' ').trim()}; ${outcome.note}` }
}

function named(rail: string, verdict: Verdict): Outcome {
  return { outcome: verdict.outcome, spans: verdict.spans, note: `${rail}: ${verdict.message}` }
}
