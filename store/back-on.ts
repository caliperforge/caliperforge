import type { Db } from './index.ts'

export interface BackOn { pipe: number; name: string; plan: number; origin: string; evidence: string }

export function backOn(db: Db): BackOn[] {
  return db.prepare(`SELECT pi.id AS pipe, pi.name, min(f.id) AS plan, f.origin, d.evidence FROM pipes pi
    JOIN events s ON s.id = (SELECT max(e.id) FROM events e JOIN plans p ON p.id = e.plan
      WHERE e.kind = 'pipe' AND e.actor = 'settle' AND p.pipe_id = pi.id)
    JOIN plans f ON f.state = 'done' AND (f.origin IN (SELECT r.pointer FROM events r WHERE r.kind = 'director' AND r.id > s.id
        AND r.plan IN (SELECT id FROM plans WHERE pipe_id = pi.id))
      OR (EXISTS (SELECT 1 FROM refusals a JOIN refusals b ON b.fingerprint = a.fingerprint
        WHERE a.plan = s.plan AND ' ' || f.title || ' ' GLOB '*[^0-9]plan ' || b.plan || '[^0-9]*')
        AND NOT EXISTS (SELECT 1 FROM events t WHERE t.kind = 'pipe' AND t.actor = 'tick' AND t.plan = f.id
          AND t.message GLOB pi.name || ' *')))
    JOIN deliverables d ON d.plan_id = f.id AND d.state = 'pushed'
    WHERE pi.enabled = 0 AND NOT EXISTS (SELECT 1 FROM events o WHERE o.kind = 'pipe' AND o.id > s.id
      AND o.actor IN ('tick', 'ceo', 'coo') AND o.message GLOB pi.name || ' *')
    GROUP BY pi.id`).all() as BackOn[]
}
