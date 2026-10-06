import { logged } from './events.ts'
import type { Db } from './index.ts'
import type { PlanRow } from './plans.ts'

const SENT = 'fork.sent'
const JUDGED = 'fork.judged'

/** `verdicts` has no `at`, so event ids are the only order a send and its verdict share. */
const HOLDS = (plan: string): string => `(SELECT e.kind FROM events e WHERE e.plan = ${plan}
  AND e.kind IN ('${SENT}', '${JUDGED}') ORDER BY e.id DESC LIMIT 1) = '${SENT}'`

function holds(db: Db, plan: number): boolean {
  return db.prepare(`SELECT ${HOLDS('?')} AS held`).pluck().get(plan) === 1
}

function log(db: Db, plan: number, kind: string): void {
  logged(db, { plan, kind, actor: 'tick', outcome: 'pass', message: kind, pointer: null, run: null })
}

export function took(db: Db, plan: number): void {
  if (!holds(db, plan)) log(db, plan, SENT)
}

export function freed(db: Db, plan: number): void {
  if (holds(db, plan)) log(db, plan, JUDGED)
}

/** The plan whose fork CI this one waits on: the repo's holder, or a proven step-6 plan sorting before it. */
export function waitsFor(db: Db, plan: PlanRow): number | null {
  if (holds(db, plan.id)) return null
  const id = db.prepare(`SELECT o.id FROM plans o JOIN targets t ON t.id = o.target_id
    JOIN targets mine ON mine.id = @target AND mine.repo = t.repo
    WHERE o.state IN ('queued', 'running') AND (${HOLDS('o.id')}
      OR (o.template = 'pr_path' AND o.step = 6 AND (o.priority, o.id) < (@priority, @id)
        AND EXISTS (SELECT 1 FROM deliverables d WHERE d.plan_id = o.id AND d.tests_pass = 1
          AND d.byte_identical_elsewhere = 1 AND d.bot_clean = 1 AND d.target_warm = 1)))
    ORDER BY o.priority, o.id LIMIT 1`).pluck().get({ target: plan.target_id, priority: plan.priority, id: plan.id })
  return (id ?? null) as number | null
}
