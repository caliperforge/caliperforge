import { judge, MISSING, type Gh } from '../rails/ci-green/index.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { entries, type Failure } from './checks.ts'
import { homeOf, kernelPlan } from './home.ts'
import type { Outcome } from './kind.ts'
import { carries, holding, sent, unfinished, WIRE, workflows, type Wire } from './push.ts'
import { srcDir } from './workspace.ts'

/** The settings row that moves step 3's suite off this laptop: `ci`, or anything else for the laptop. */
export const WHERE = 'checks.where'

/** Ticks a pushed head is given for its first run to show before the laptop runs the suite instead. */
export const SHOWS = 5

/** Ticks a run is given to finish. Our suite takes about two minutes on GitHub. */
export const RUNS = 20

const WAITS = 'ci.waits.checks'

const TAIL = 80

const RED = /\/actions\/runs\/(\d+) ci\.red$/

const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const SCRIPT = /npm run (\w+)/

const EXIT = /exit code (\d+)/

export type Ci = { wait: Outcome } | { failed: Failure | null; at: string }

/**
 * #332. Our own repo's suite runs on GitHub at the branch head instead of on the laptop, where under load it
 * ran past the ten-minute cap (09-26). The head is committed and sent as step 6 sends it, and the runs at that sha
 * are the checks. Null hands the checks back to the laptop: the switch is off, the repo runs no workflow, the push
 * or the listing failed, no run showed within `SHOWS` ticks, or one ran past `RUNS`.
 */
export function ciChecks(db: Db, root: string, plan: PlanRow, wire: Wire = WIRE): Ci | null {
  if (!on(db) || !kernelPlan(plan) || !workflows(srcDir(root, plan.id))) return null
  try {
    const { fork, head, ci } = sent(db, root, plan, homeOf(plan), wire)
    const { verdict } = judge({ fork, branch: ci, sha: head.sha }, { body: '', commits: [] }, [], wire.runs)
    const at = `${fork}@${head.sha.slice(0, 12)}`
    const waiting = unfinished(verdict.spans)
    if (waiting !== null) {
      const window = carries(verdict.spans, MISSING) ? SHOWS : RUNS
      const hold = holding(root, plan.id, head.sha, verdict.spans, `${at} ${waiting}`, window, WAITS)
      return hold === null ? null : { wait: hold }
    }
    if (carries(verdict.spans, 'ci.unreadable')) return null
    return { failed: verdict.outcome === 'pass' ? null : failure(srcDir(root, plan.id), fork, verdict.spans, wire.runs), at }
  } catch {
    return null
  }
}

function on(db: Db): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WHERE) as { value: string } | undefined
  return row?.value === 'ci'
}

/** The first red run's failed step, read as the laptop's own failure: the script it ran and the tests it named. */
function failure(src: string, fork: string, spans: string[], gh: Gh): Failure {
  const span = spans.find((s) => RED.test(s)) ?? ''
  const url = span.split(' ')[0] ?? fork
  const id = RED.exec(span)?.[1]
  const cells = (id === undefined ? '' : gh(['run', 'view', id, '--repo', fork, '--log-failed'])).split('\n').map((l) => l.split('\t'))
  const step = cells.find((c) => c.length >= 3)?.[1] ?? 'CI'
  const output = cells.map((c) => (c.length >= 3 ? c.slice(2).join('\t') : c.join('\t')).replace(STAMP, '').replace(ANSI, '')).join('\n')
  const script = SCRIPT.exec(step)?.[1] ?? step
  return {
    script,
    command: `${SCRIPT.test(step) ? `npm run ${script}` : step} on GitHub CI`,
    code: EXIT.exec(output)?.[1] ?? '1',
    output: `${url}\n\n${output.split('\n').slice(-TAIL).join('\n')}`,
    tests: entries(src, output),
    retried: false,
  }
}
