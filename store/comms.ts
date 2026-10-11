import type { Db } from './index.ts'

export function commsLane(db: Db): void {
  db.prepare(`INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent)
    VALUES ('comms', 1, '07:00', '22:00', 1)`).run()
}

/** `plans_one_comms` holds a comms title to one plan, so a title already filed files nothing. */
export function fileComms(db: Db, title: string, target: number | null, at: string): number | null {
  const made = db.prepare(`INSERT OR IGNORE INTO plans (pipe_id, target_id, template, state, queued_at, step, retries, title)
    VALUES ((SELECT id FROM pipes WHERE name = 'comms'), ?, 'comms', 'queued', ?, 0, 0, ?)`).run(target, at, title)
  return made.changes === 1 ? Number(made.lastInsertRowid) : null
}
