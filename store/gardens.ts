import type { Db } from './index.ts'
import { live, type PipeRow } from './plans.ts'

export function gardened(db: Db, day: string): boolean {
  return db.prepare('SELECT 1 FROM gardens WHERE day = ?').get(day) !== undefined
}

export function openGardens(db: Db): number {
  return (db.prepare(`SELECT count(*) AS n FROM gardens g
    JOIN tickets t ON g.url = 'https://github.com/' || t.repo || '/issues/' || t.number`).get() as { n: number }).n
}

export function idle(db: Db, pipe: PipeRow): boolean {
  const plans = live(db, pipe)
  return plans.length < pipe.max_concurrent && plans.every((p) => p.priority > 2)
}

export function record(db: Db, day: string, metric: string, url: string): void {
  db.prepare('INSERT INTO gardens (day, metric, url) VALUES (?, ?, ?)').run(day, metric, url)
}
