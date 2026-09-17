import { z } from 'zod'
import type { Db } from './index.ts'

export const PipeRow = z.object({
  id: z.int(),
  name: z.string(),
  enabled: z.int(),
  window_start: z.string(),
  window_end: z.string(),
  max_concurrent: z.int(),
})

export type PipeRow = z.infer<typeof PipeRow>

export const PlanRow = z.object({
  id: z.int(),
  pipe_id: z.int(),
  target_id: z.int().nullable(),
  template: z.enum(['pr_path', 'research', 'comms']),
  state: z.enum(['queued', 'running', 'blocked_on_ceo', 'halted', 'done', 'refused']),
  queued_at: z.string(),
  step: z.int(),
  retries: z.int(),
})

export type PlanRow = z.infer<typeof PlanRow>

export function clock(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

export function inWindow(pipe: PipeRow, hhmm: string): boolean {
  return pipe.window_start <= pipe.window_end
    ? hhmm >= pipe.window_start && hhmm <= pipe.window_end
    : hhmm >= pipe.window_start || hhmm <= pipe.window_end
}

export function openPipes(db: Db, hhmm: string): PipeRow[] {
  return db.prepare('SELECT * FROM pipes WHERE enabled = 1 ORDER BY id').all()
    .map((r) => PipeRow.parse(r))
    .filter((p) => inWindow(p, hhmm))
}

export function live(db: Db, pipe: PipeRow): PlanRow[] {
  return db.prepare("SELECT * FROM plans WHERE pipe_id = ? AND state IN ('queued', 'running') ORDER BY queued_at, id")
    .all(pipe.id).map((r) => PlanRow.parse(r))
}

export function underCap(pipe: PipeRow, plans: PlanRow[]): PlanRow[] {
  const running = plans.filter((p) => p.state === 'running')
  return running.length >= pipe.max_concurrent ? running : plans
}

export function advance(db: Db, plan: PlanRow, step: number): void {
  db.prepare("UPDATE plans SET step = ?, state = 'running' WHERE id = ?").run(step, plan.id)
}

export function back(db: Db, plan: PlanRow): 'retried' | 'blocked_on_ceo' {
  if (plan.retries >= 1) {
    db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
    return 'blocked_on_ceo'
  }
  db.prepare("UPDATE plans SET step = ?, retries = retries + 1, state = 'running' WHERE id = ?")
    .run(Math.max(plan.step - 1, 0), plan.id)
  return 'retried'
}

export function needsCeo(db: Db, plan: PlanRow): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo' WHERE id = ?").run(plan.id)
}
