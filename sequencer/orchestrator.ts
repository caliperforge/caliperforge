import { createHash } from 'node:crypto'
import type { Provider } from '../providers/kind.ts'
import { alerter, type Post } from '../cli/watch.ts'
import { clear as unlease, take } from '../store/leases.ts'
import type { Db } from '../store/index.ts'
import { PlanRow } from '../store/plans.ts'
import { cooLite } from './coolite.ts'
import { released } from './fixer.ts'
import { isHeld } from './hold.ts'
import { WIRE, type Wire } from './push.ts'
import { maybe, put } from './workspace.ts'

export const WAKE = ['token_ceiling', 'ready_proof', 'target_parked', 'no_step_map'] as const

type Woken = (typeof WAKE)[number] | 'blocked_on_ceo'

/** The lease keeps two overlapping ticks off one stop. */
export async function woke(db: Db, root: string, provider: Provider, now: Date, post: Post = alerter(), wire: Wire = WIRE): Promise<void> {
  released(db, root, now, post)
  const rows = db.prepare(`SELECT * FROM plans WHERE ((wait_reason IN (${WAKE.map(() => '?').join(', ')})
    AND state IN ('queued', 'running', 'blocked_on_ceo')) OR state = 'blocked_on_ceo') AND held_by IS NOT 'ceo' ORDER BY id`).all(...WAKE)
  for (const plan of rows.map((r) => PlanRow.parse(r))) {
    const reason = woken(plan)
    const head = `step ${String(plan.step)} ${reason === 'blocked_on_ceo' ? `blocked ${stop(root, plan.id)}` : reason}`
    if (isHeld(root, plan.id)) continue
    if (maybe(root, plan.id, 'orchestrator.md')?.split('\n')[0] === head) continue
    if (take(db, plan.id, now) === null) continue
    try {
      put(root, plan.id, 'orchestrator.md', `${head}\n\n${await cooLite(db, root, plan, provider, now, post, wire)}\n`)
    } finally {
      unlease(db, plan.id)
    }
  }
}

function woken(plan: PlanRow): Woken {
  return (WAKE as readonly string[]).includes(plan.wait_reason ?? '') ? plan.wait_reason as Woken : 'blocked_on_ceo'
}

/** One stop is one refusal (or question) as written; the same words at the same step are the same stop. */
function stop(root: string, plan: number): string {
  const said = maybe(root, plan, 'refusal.md') ?? maybe(root, plan, 'question.md')
  return said === null ? 'none' : createHash('sha256').update(said).digest('hex').slice(0, 12)
}
