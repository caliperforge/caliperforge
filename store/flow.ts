import type { Db } from './index.ts'

export function running(db: Db, pipe: number): number {
  return (db.prepare("SELECT count(*) AS n FROM plans WHERE pipe_id = ? AND state = 'running'").get(pipe) as { n: number }).n
}

export function pushed(db: Db, plan: number): boolean {
  return db.prepare("SELECT 1 FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(plan) !== undefined
}

export function shut(db: Db, repo: string, no: number): boolean {
  const { closed } = db.prepare(`SELECT EXISTS (SELECT 1 FROM tickets WHERE repo = ?)
    AND NOT EXISTS (SELECT 1 FROM tickets WHERE repo = ? AND number = ? AND closed_at IS NULL) AS closed`).get(repo, repo, no) as { closed: number }
  return closed === 1
}

export function stuck(db: Db, plan: number, now: Date): boolean {
  return db.prepare(`SELECT 1 FROM refusals f
    WHERE f.id = (SELECT max(id) FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0)
      AND EXISTS (SELECT 1 FROM refusals e WHERE e.plan = f.plan AND e.id < f.id AND e.cleared = 0 AND e.blip = 0
        AND e.fingerprint = f.fingerprint)
      AND julianday(f.at) < julianday(?, '-30 minutes')
      AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.plan = f.plan AND julianday(d.at) > julianday(f.at))`)
    .get(plan, now.toISOString()) !== undefined
}

export function orphans(db: Db): { number: number; after: number }[] {
  return db.prepare(`SELECT t.number, a.value AS after FROM parts p
    JOIN tickets t ON p.url = 'https://github.com/' || t.repo || '/issues/' || t.number, json_each(t.after) a
    WHERE p.plan IS NULL
      AND NOT EXISTS (SELECT 1 FROM tickets o WHERE o.repo = t.repo AND o.number = a.value)
    ORDER BY t.repo, t.number`).all() as { number: number; after: number }[]
}

export function idled(db: Db): { name: string; free: number; startable: number }[] {
  return db.prepare(`WITH recent AS (SELECT id FROM ticks WHERE dry = 0 ORDER BY id DESC LIMIT 2)
    SELECT p.name, l.free, l.startable FROM tick_lanes l
      JOIN pipes p ON p.id = l.pipe
      JOIN tick_lanes e ON e.pipe = l.pipe AND e.tick < l.tick AND e.tick IN (SELECT id FROM recent)
    WHERE l.tick = (SELECT max(id) FROM recent) AND l.free > 0 AND l.startable > 0 AND e.free > 0 AND e.startable > 0
    ORDER BY p.id`).all() as { name: string; free: number; startable: number }[]
}
