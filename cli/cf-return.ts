import type { Command } from 'commander'
import type { At } from '../sequencer/forward.ts'
import { unhold } from '../sequencer/hold.ts'
import { premised } from '../sequencer/premised.ts'
import { reread } from '../sequencer/reread.ts'
import { opened } from '../sequencer/rule.ts'
import { holderOf, originRef, planById, type PlanRow } from '../store/plans.ts'
import { restartAt, resumesAt } from '../templates/resumed.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, type Read, type Run, run } from './gh.ts'
import { reopenIssue } from './reopen.ts'

export function registerReturn(command: Command, { root, db, out }: Cli, read: Read = gh, exec: Run = run): void {
  command.option('--to <step>', 'an earlier step to resume at, retries and signed head cleared')
    .option('--at <step>', 'a later step to resume at, once what it reads is in the plan folder')
    .option('--why <text>', 'why it resumes there; needed with --at')
    .option('--from-phase <name>', 'with --to 1, the lean phase a bench plan restarts at')
    .action((id: string, options: { by: string; to?: string; at?: string; why?: string; fromPhase?: string }) => {
      const to = options.to === undefined ? undefined : Number(options.to)
      const by = holderOf(options.by)
      const at = resumed(options.at, options.why, to)
      if (options.fromPhase !== undefined) restarted(root, Number(id), options.fromPhase, to)
      const handle = db()
      const missed = opened(handle, root, Number(id))
      const reopening = planById(handle, Number(id)).state === 'done'
      const step = unhold(handle, root, Number(id), by, to, at)
      const plan = planById(handle, Number(id))
      if (reopening) reopen(root, plan, read, exec)
      if (step <= 1) reread(handle, root, plan, by, read)
      out(`plan ${id} queued at step ${String(step)}\n`)
      const phase = step === 1 ? resumesAt(root, Number(id)) : null
      if (phase !== null) out(`  resumes at ${phase}\n`)
      if (missed.length > 0) out(`  not in the checkout: ${missed.join(', ')}\n`)
    })
}

export function reopen(root: string, plan: PlanRow, read: Read, exec: Run): void {
  const ref = originRef(plan)
  if (ref !== null) reopenIssue(ref.repo, ref.no, read, exec)
  premised(root, plan.id)
}

function resumed(at: string | undefined, why: string | undefined, to: number | undefined): At | undefined {
  if (at === undefined) return undefined
  if (to !== undefined) throw new Error('--at and --to cannot both be given')
  if (why === undefined) throw new Error('--at needs --why')
  return { step: Number(at), why }
}

function restarted(root: string, plan: number, phase: string, to: number | undefined): void {
  if (to !== 1) throw new Error('--from-phase needs --to 1')
  restartAt(root, plan, phase)
}
