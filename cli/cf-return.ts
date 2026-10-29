import type { Command } from 'commander'
import type { At } from '../sequencer/forward.ts'
import { unhold } from '../sequencer/hold.ts'
import { reread } from '../sequencer/reread.ts'
import { opened } from '../sequencer/rule.ts'
import { holderOf, planById } from '../store/plans.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, type Read } from './gh.ts'

export function registerReturn(command: Command, { root, db, out }: Cli, read: Read = gh): void {
  command.option('--to <step>', 'an earlier step to resume at, retries and signed head cleared')
    .option('--at <step>', 'a later step to resume at, once what it reads is in the plan folder')
    .option('--why <text>', 'why it resumes there; needed with --at')
    .action((id: string, options: { by: string; to?: string; at?: string; why?: string }) => {
      const to = options.to === undefined ? undefined : Number(options.to)
      const by = holderOf(options.by)
      const at = resumed(options.at, options.why, to)
      const handle = db()
      const missed = opened(handle, root, Number(id))
      const step = unhold(handle, root, Number(id), by, to, at)
      if (step <= 1) reread(handle, root, planById(handle, Number(id)), by, read)
      out(`plan ${id} queued at step ${String(step)}\n`)
      if (missed.length > 0) out(`  not in the checkout: ${missed.join(', ')}\n`)
    })
}

function resumed(at: string | undefined, why: string | undefined, to: number | undefined): At | undefined {
  if (at === undefined) return undefined
  if (to !== undefined) throw new Error('--at and --to cannot both be given')
  if (why === undefined) throw new Error('--at needs --why')
  return { step: Number(at), why }
}
