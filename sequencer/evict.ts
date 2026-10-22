import { spawnSync } from 'node:child_process'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { alive } from '../store/leases.ts'

interface Proc {
  pid: number
  ppid: number
  command: string
}

/** Kills the lap a lease was taken over from, and every process under it, before this lap steps the plan. */
export function evict(db: Db, plan: number, stole: number): void {
  const message = `took over pid ${String(stole)}: ${verdict(plan, stole)}`
  logged(db, { plan, kind: 'steal', actor: 'tick', outcome: 'pass', message, pointer: null, run: null })
  process.stderr.write(`plan ${String(plan)} ${message}\n`)
}

function verdict(plan: number, stole: number): string {
  if (!alive(stole)) return 'dead'
  const procs = ps()
  const holder = procs.find((p) => p.pid === stole)
  if (holder === undefined || !new RegExp(`\\blap ${String(plan)}\\b`).test(holder.command)) {
    return `alive, not a lap of plan ${String(plan)}`
  }
  const tree = [stole]
  for (const pid of tree) tree.push(...procs.filter((p) => p.ppid === pid).map((p) => p.pid))
  return `alive, killed ${String(tree.filter(kill).length)} processes`
}

function ps(): Proc[] {
  const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`ps exited ${String(out.status)}: ${out.stderr}`)
  return out.stdout.split('\n').flatMap((line) => {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line) ?? []
    return command === undefined ? [] : [{ pid: Number(pid), ppid: Number(ppid), command }]
  })
}

function kill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false
    throw error
  }
}
