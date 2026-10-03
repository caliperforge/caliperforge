import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { parentOf, refusedOf, spendOf } from '../store/record.ts'
import { maybe } from './workspace.ts'

/** A part's own ask holds only its slice; the parent's ticket holds the lists and facts the part was cut from. */
export function parentAsk(db: Db, root: string, plan: PlanRow): string {
  const parent = parentOf(db, plan.id)
  return parent === null ? 'none' : (maybe(root, parent, 'ask.md') ?? 'none').slice(0, 6000)
}

/** What the job has already been through, so a stop is judged on its history and not only its last refusal. */
export function history(db: Db, plan: PlanRow): string {
  const { n, tokens, usd } = spendOf(db, plan.id)
  const lines = refusedOf(db, plan.id).map((v) => `- step ${String(v.step)} ${v.what} ${v.outcome}${v.message === '' ? '' : `: ${v.message.slice(0, 160)}`}`)
  return [`${String(n)} runs, ${String(tokens)} tokens, $${usd.toFixed(2)}`,
    lines.length === 0 ? 'no refusing verdicts' : `latest refusing verdicts, newest first:\n${lines.join('\n')}`].join('\n')
}
