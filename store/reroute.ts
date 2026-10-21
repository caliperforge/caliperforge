import type { Db } from './index.ts'

export function toResearch(db: Db, plan: number, pipe: number, seat: string): void {
  db.prepare("UPDATE plans SET template = 'research', lane = 'research', pipe_id = ?, seat = ? WHERE id = ?").run(pipe, seat, plan)
}
