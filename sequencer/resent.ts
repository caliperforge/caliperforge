import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { profile } from '../store/profile.ts'
import { fold, messageOf, sent, type Wire } from './push.ts'

/** `sent`, sent again when the head it sent is folded after the send. */
export function resent(db: Db, root: string, plan: PlanRow, repo: string, wire: Wire): ReturnType<typeof sent> & { folded: string | null } {
  const first = sent(db, root, plan, repo, wire)
  const folded = first.rejected !== null || first.base === null ? null : fold(first.head.dir, first.base, messageOf(root, plan.id, profile(root, repo, plan.id)))
  return { ...(folded === null ? first : sent(db, root, plan, repo, wire)), folded }
}
