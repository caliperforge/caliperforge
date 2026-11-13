import { z } from 'zod'
import { trunk } from '../cli/gh.ts'
import type { Gh } from '../rails/ci-green/index.ts'
import type { Wire } from './push.ts'
import { get, maybe, put } from './workspace.ts'

/** The `-next` branch `sent` last pushed. */
const SENT = 'ci.sent'

const ID = /\/actions\/runs\/(\d+)/

const Runs = z.array(z.object({ status: z.string(), url: z.string() }))

const Status = z.object({ status: z.string() })

/** Every fork shares one Actions pool, so a run step 6 will never read is cancelled before it holds a slot. */
export function cancel(fork: string, branch: string, gh: Gh): void {
  const runs = Runs.parse(JSON.parse(gh(['run', 'list', '--repo', fork, '--branch', branch, '--limit', '100', '--json', 'status,url'])))
  for (const run of runs.filter((r) => r.status !== 'completed')) {
    const id = ID.exec(run.url)?.[1] ?? ''
    try {
      gh(['run', 'cancel', id, '--repo', fork])
    } catch (e) {
      if (!(e as Error).message.includes('completed') && Status.parse(JSON.parse(gh(['run', 'view', id, '--repo', fork, '--json', 'status']))).status !== 'completed') throw e
    }
  }
}

export function retire(fork: string, branch: string, wire: Wire): void {
  wire.unrehearse?.(fork, branch)
  cancel(fork, branch, wire.runs)
}

export function moved(root: string, plan: number, fork: string, ci: string, wire: Wire): void {
  const last = maybe(root, plan, SENT)
  if (last !== null && last !== ci) retire(fork, last, wire)
  put(root, plan, SENT, ci)
}

/** The move of the fork's default branch to `base.sha`, before the head goes out, starts the fork's default branch workflows. */
export function based(root: string, plan: number, fork: string, wire: Wire): void {
  if (wire.forward === undefined) return
  wire.forward(fork, get(root, plan, 'base.sha').trim())
  cancel(fork, trunk(fork, wire.merged), wire.runs)
}
