import type { Gh } from '../rails/ci-green/index.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { firstLine } from './unpolled.ts'

const RED = /\/actions\/runs\/(\d+) ci\.red$/

const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/g

const TAIL = 60

interface Red {
  spans: string[]
  log: string
}

/**
 * What their CI says failed, in the words the builder needs -- each red run's workflow and
 * the tail of its failed steps' log. Timestamps go, so the same failure reads the same twice.
 */
export function red(db: Db, plan: number, fork: string, spans: string[], gh: Gh): Red | null {
  const ids = spans.flatMap((s) => RED.exec(s)?.[1] ?? [])
  if (ids.length === 0) return null
  const runs = ids.map((id) => ({ name: nameOf(db, plan, fork, id, gh), log: logOf(db, plan, fork, id, gh) }))
  return {
    spans: runs.map((r) => `ci.red ${r.name}`),
    log: runs.map((r) => `## ${r.name}\n\n${r.log}`).join('\n\n'),
  }
}

export interface Failed { job: string; step: string }

/** Each job and step `--log-failed` names, once. */
export function failing(fork: string, id: string, gh: Gh): Failed[] {
  const seen = new Map<string, Failed>()
  for (const line of gh(['run', 'view', id, '--repo', fork, '--log-failed']).split('\n')) {
    const [job, step] = line.split('\t')
    if (job !== undefined && step !== undefined) seen.set(`${job}\t${step}`, { job, step })
  }
  return [...seen.values()]
}

function nameOf(db: Db, plan: number, fork: string, id: string, gh: Gh): string {
  try {
    const run = JSON.parse(gh(['run', 'view', id, '--repo', fork, '--json', 'workflowName'])) as { workflowName?: unknown }
    return typeof run.workflowName === 'string' ? run.workflowName : `run ${id}`
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'red', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
    return `run ${id}`
  }
}

function logOf(db: Db, plan: number, fork: string, id: string, gh: Gh): string {
  try {
    const failed = gh(['run', 'view', id, '--repo', fork, '--log-failed'])
    return failed.trim() ? tail(failed) : jobsOf(fork, id, gh)
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'red', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
    return '(the failed log could not be read)'
  }
}

const tail = (log: string): string => log.replace(STAMP, '').split('\n').slice(-TAIL).join('\n')

interface Job { databaseId: number; name: string; conclusion: string; steps: { name: string; conclusion: string }[] }

const PASSED = ['success', 'skipped', 'neutral']

/** `--log-failed` prints nothing when gh cannot match a job's steps in the run's log archive. */
function jobsOf(fork: string, id: string, gh: Gh): string {
  const run = JSON.parse(gh(['run', 'view', id, '--repo', fork, '--json', 'conclusion,jobs'])) as { conclusion: string; jobs: Job[] }
  const jobs = run.jobs.filter((j) => !PASSED.includes(j.conclusion))
  if (jobs.length === 0) return `run ${id} ended ${run.conclusion} with no failed job`
  return jobs.map((j) => {
    const steps = j.steps.filter((s) => !PASSED.includes(s.conclusion)).map((s) => s.name).join(', ')
    return `${j.name}: ${steps}\n${tail(gh(['api', `repos/${fork}/actions/jobs/${String(j.databaseId)}/logs`]))}`
  }).join('\n')
}
