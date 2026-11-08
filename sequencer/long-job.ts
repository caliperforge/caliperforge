import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { eventsOf, logged, ofKind } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { count } from '../store/lanes.ts'
import { end, type PlanRow, terminal } from '../store/plans.ts'
import { work } from '../templates/research.ts'
import type { Ran } from '../templates/verified.ts'
import type { Outcome } from './kind.ts'
import { get, put, srcDir } from './workspace.ts'

const KIND = 'long_job'

const TAIL = 200

export const RUN = /^\*\*Run:\*\*(.*)$/m

const OUTPUT = /^\*\*Output:\*\*(.*)$/m

interface Job { command: string; out: string; pid: number; at: string }

const jobOf = (root: string, plan: number): Job => JSON.parse(get(root, plan, 'job.json')) as Job

/** Starts a measurer reply's `**Run:**` command detached, writing to the reply's `**Output:**` folder. */
export function launched(db: Db, root: string, plan: PlanRow, reply: string): Outcome {
  const [command = '', named] = [RUN, OUTPUT].map((line) => line.exec(reply)?.[1]?.trim())
  const out = named === undefined ? null : work(named)
  if (out === null) return { outcome: 'refuse', spans: ['research.long_job'], note: '**Run:** needs an **Output:** folder under ~/cf_work/' }
  mkdirSync(out, { recursive: true })
  detach(db, root, plan, command, out)
  return { outcome: 'pass', held: true, spans: [], note: `long job started: ${command}` }
}

/** `job.exit` is renamed into place, so a tick never reads it half written. */
function detach(db: Db, root: string, plan: PlanRow, command: string, out: string): void {
  const log = join(out, 'job.log')
  rmSync(join(out, 'job.exit'), { force: true })
  const fd = openSync(log, 'w')
  const child = spawn('/bin/sh', ['-c', '(eval "$1"); echo $? > "$2.part"; mv "$2.part" "$2"', 'sh', command, join(out, 'job.exit')],
    { cwd: srcDir(root, plan.id), detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  closeSync(fd)
  put(root, plan.id, 'job.json', JSON.stringify({ command, out, pid: child.pid, at: new Date().toISOString() }))
  logged(db, { plan: plan.id, kind: KIND, actor: 'started', outcome: 'pass', message: command, pointer: log, run: null })
}

export const running = (db: Db, plan: PlanRow): boolean => eventsOf(db, plan.id, KIND).at(-1)?.actor === 'started'

/** The `# Long job` section gather's input gains once the job has exited. */
export function exited(db: Db, root: string, plan: PlanRow): string | null {
  const newest = eventsOf(db, plan.id, KIND).at(-1)
  if (newest?.actor !== 'exited') return null
  const { command, out } = jobOf(root, plan.id)
  const log = join(out, 'job.log')
  const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-TAIL).join('\n')
  return `\n\n# Long job\n\n\`${command}\` exited ${newest.message.slice('exit '.length)}; its log, ${log}, ends:\n\n${tail}`
}

/** The exited job as a run an answer may cite, its output the whole of `job.log`. */
export function jobRun(db: Db, root: string, plan: PlanRow): Ran[] {
  if (eventsOf(db, plan.id, KIND).at(-1)?.actor !== 'exited') return []
  const { command, out } = jobOf(root, plan.id)
  return [{ command, output: readFileSync(join(out, 'job.log'), 'utf8') }]
}

export function longJobs(db: Db, root: string, now: Date): void {
  const seconds = count(db, 'research.long_job_seconds')
  const ended = new Set(terminal(db))
  for (const [plan, actor] of new Map(ofKind(db, KIND).map((e) => [e.plan ?? 0, e.actor]))) {
    if (actor !== 'started') continue
    const job = jobOf(root, plan)
    const log = join(job.out, 'job.log')
    const exit = join(job.out, 'job.exit')
    if (existsSync(exit)) {
      logged(db, { plan, kind: KIND, actor: 'exited', outcome: 'pass', message: `exit ${readFileSync(exit, 'utf8').trim()}`, pointer: log, run: null })
      continue
    }
    if (now.getTime() - Date.parse(job.at) < seconds * 1000) continue
    try {
      process.kill(-job.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    logged(db, { plan, kind: KIND, actor: 'walled', outcome: 'refuse', message: `walled at ${String(seconds)}s`, pointer: log, run: null })
    if (ended.has(plan)) continue
    end(db, plan, 'halted', `long job walled at ${String(seconds)}s: ${job.command}`)
  }
}
