import type { Db } from './index.ts'

export function laneHeld(db: Db, pipe: number, why: string): void {
  db.prepare("UPDATE plans SET state = 'blocked_on_ceo', held_by = 'coo', held_why = ? WHERE pipe_id = ? AND state = 'running'")
    .run(why.split('\n')[0] ?? null, pipe)
}
