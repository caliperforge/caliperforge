import type { Db } from './index.ts'
import { PlanRow } from './plans.ts'

export function pipesOn(db: Db): Set<string> {
  return new Set((db.prepare('SELECT name FROM pipes WHERE enabled = 1').all() as { name: string }[]).map((p) => p.name))
}

export function unpushed(db: Db): PlanRow[] {
  return db.prepare(`SELECT * FROM plans WHERE state = 'queued' AND origin IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deliverables d WHERE d.plan_id = plans.id AND d.state = 'pushed')`).all().map((r) => PlanRow.parse(r))
}

export function pushedLive(db: Db): PlanRow[] {
  return db.prepare(`SELECT p.* FROM plans p WHERE p.state IN ('queued', 'running', 'blocked_on_ceo') AND p.origin IS NOT NULL
    AND EXISTS (SELECT 1 FROM deliverables d WHERE d.plan_id = p.id AND d.state = 'pushed')`).all().map((r) => PlanRow.parse(r))
}

export function pulls(db: Db): { plan: number; repo: string; evidence: string }[] {
  return db.prepare(`SELECT d.plan_id AS plan, t.repo, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*'
    UNION
    SELECT p.id AS plan, t.repo, t.evidence
    FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE t.evidence GLOB 'https://*/pull/*'
    ORDER BY plan`).all() as { plan: number; repo: string; evidence: string }[]
}

export function rehearsing(db: Db): { plan: number; repo: string }[] {
  return db.prepare(`SELECT p.id AS plan, t.repo FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE p.origin IS NULL AND p.state IN ('running', 'blocked_on_ceo') ORDER BY p.id`).all() as { plan: number; repo: string }[]
}
