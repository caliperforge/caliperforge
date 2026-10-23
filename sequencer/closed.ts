import { z } from 'zod'
import type { Read } from '../cli/gh.ts'
import { record } from '../cli/inbox.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { originRef } from '../store/plans.ts'
import { unhold } from './hold.ts'
import { firstLine } from './unpolled.ts'

const Issue = z.object({ state: z.string(), stateReason: z.string().nullable() })

interface Waiter { id: number; step: number; on_: number; theirs: string; origin: string | null }

/** A job waiting on a refused or halted plan goes back to its lane when that plan's issue is closed as completed. */
export function closed(db: Db, root: string, r: Waiter, held: { ticket: string; at: string; note: string }, read: Read): boolean {
  if (!completed(db, r, read)) {
    logged(db, { plan: r.id, kind: 'waits_closed', actor: 'fixer', outcome: 'needs_coo', message: held.note, pointer: r.origin, run: null })
    return false
  }
  const note = `plan ${String(r.on_)} ended ${r.theirs}, but ${r.origin ?? ''} is closed as completed, so this job is back in its lane`
  unhold(db, root, r.id, 'fixer')
  record(root, [{ at: held.at, plan: r.id, ticket: held.ticket, kind: 'refused', step: r.step, name: 'fixer', note }])
  logged(db, { plan: r.id, kind: 'waits_closed', actor: 'fixer', outcome: 'pass', message: note, pointer: r.origin, run: null })
  return true
}

function completed(db: Db, r: Waiter, read: Read): boolean {
  const ref = originRef(r)
  if (ref === null) return false
  try {
    const issue = Issue.parse(read(['issue', 'view', String(ref.no), '--repo', ref.repo, '--json', 'state,stateReason']))
    return issue.state === 'CLOSED' && issue.stateReason === 'COMPLETED'
  } catch (error) {
    logged(db, { plan: r.id, kind: 'swallowed', actor: 'fixer', outcome: 'pass', message: firstLine(error), pointer: r.origin, run: null })
    return false
  }
}
