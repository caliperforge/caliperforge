import { z } from 'zod'
import type { Gh } from '../rails/ci-green/index.ts'
import type { Wire } from './push.ts'
import { maybe, put } from './workspace.ts'

/** The `-next` branch `sent` last pushed. */
const SENT = 'ci.sent'

const ID = /\/actions\/runs\/(\d+)/

const Runs = z.array(z.object({ status: z.string(), url: z.string() }))

/** Every fork shares one Actions pool, so a run step 6 will never read is cancelled before it holds a slot. */
export function cancel(fork: string, branch: string, gh: Gh): void {
  const runs = Runs.parse(JSON.parse(gh(['run', 'list', '--repo', fork, '--branch', branch, '--limit', '100', '--json', 'status,url'])))
  for (const run of runs.filter((r) => r.status !== 'completed')) {
    try {
      gh(['run', 'cancel', ID.exec(run.url)?.[1] ?? '', '--repo', fork])
    } catch {
      // The run finished between the list and the cancel.
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

/** A rehearsal's `gh repo sync` starts the fork's `main` workflows. */
export function rehearsing(fork: string, ci: string, wire: Wire): void {
  wire.rehearse?.(fork, ci)
  cancel(fork, 'main', wire.runs)
}
