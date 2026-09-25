import type { Gh } from '../rails/ci-green/index.ts'

const RED = /\/actions\/runs\/(\d+) ci\.red$/

const STAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/g

const TAIL = 60

export interface Red {
  spans: string[]
  log: string
}

/**
 * #71: what their CI says failed, in the words the builder needs -- each red run's workflow and
 * the tail of its failed steps' log. Timestamps go, so the same failure reads the same twice.
 */
export function red(fork: string, spans: string[], gh: Gh): Red | null {
  const ids = spans.flatMap((s) => RED.exec(s)?.[1] ?? [])
  if (ids.length === 0) return null
  const runs = ids.map((id) => ({ name: nameOf(fork, id, gh), log: logOf(fork, id, gh) }))
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

function nameOf(fork: string, id: string, gh: Gh): string {
  try {
    const run = JSON.parse(gh(['run', 'view', id, '--repo', fork, '--json', 'workflowName'])) as { workflowName?: unknown }
    return typeof run.workflowName === 'string' ? run.workflowName : `run ${id}`
  } catch {
    return `run ${id}`
  }
}

function logOf(fork: string, id: string, gh: Gh): string {
  try {
    return gh(['run', 'view', id, '--repo', fork, '--log-failed']).replace(STAMP, '').split('\n').slice(-TAIL).join('\n')
  } catch {
    return '(the failed log could not be read)'
  }
}
