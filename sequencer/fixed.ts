import { createHash } from 'node:crypto'
import { ticketOf } from '../cli/inbox.ts'
import type { Post } from '../cli/watch.ts'
import type { Provider } from '../providers/kind.ts'
import { decided } from '../store/decisions.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { fixer } from './fixer.ts'
import type { Wire } from './push.ts'
import { maybe, put } from './workspace.ts'

/** One stop is one refusal (or question) as written; the same words at the same step are the same stop. */
export function stop(root: string, plan: number): string {
  const said = maybe(root, plan, 'refusal.md') ?? maybe(root, plan, 'question.md')
  return said === null ? 'none' : createHash('sha256').update(said).digest('hex').slice(0, 12)
}

/** The orchestrator's `handle()`: the fixer gets the full why, the decision row a cut one. */
export async function fixed(db: Db, root: string, plan: PlanRow, why: string, provider: Provider, now: Date, post: Post,
  wire: Wire): Promise<boolean> {
  const id = decided(db, { plan: plan.id, step: plan.step, wait_reason: 'blocked_on_ceo', verb: 'ask_coo', why: why.slice(0, 200), evidence: stop(root, plan.id), tokens: 0 })
  try {
    return await fixer(db, root, plan, { id, why }, ticketOf(db, plan.id), provider, now, post, wire)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    put(root, plan.id, 'fixer.error', message)
    logged(db, { plan: plan.id, kind: 'fixer_error', actor: 'fixer_error', outcome: 'needs_ceo', message, pointer: null, run: null })
    return false
  }
}
