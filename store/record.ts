import type { Db } from './index.ts'

export interface Spend { n: number; tokens: number; usd: number }
export interface Refused { step: number; what: string; outcome: string; message: string }

export interface Row {
  repo: string
  pr: number
  plan: number | null
  url: string
  state: string
  merged_at: string | null
  word_by: string | null
  word_at: string | null
  word: string | null
  read_at: string
  title: string | null
  opened_at: string | null
}

export function parentOf(db: Db, plan: number): number | null {
  const row = db.prepare('SELECT parent FROM parts WHERE plan = ?').get(plan) as { parent: number } | undefined
  return row?.parent ?? null
}

export function spendOf(db: Db, plan: number): Spend {
  return db.prepare(`SELECT count(*) AS n, coalesce(sum(input_tokens + output_tokens + cache_read_tokens), 0) AS tokens,
    coalesce(sum(cost_computed_usd), 0) AS usd FROM runs WHERE plan = ?`).get(plan) as Spend
}

export function repos(db: Db): string[] {
  return (db.prepare(`SELECT DISTINCT t.repo
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*'
    UNION
    SELECT t.repo FROM plans p JOIN targets t ON t.id = p.target_id WHERE t.evidence GLOB 'https://*/pull/*'
    ORDER BY repo`).all() as { repo: string }[]).map((r) => r.repo)
}

export function addRecord(db: Db, row: { repo: string; pr: number; plan: number; url: string; state: string; merged_at: string | null;
  read_at: string }): void {
  db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, read_at)
    VALUES (@repo, @pr, @plan, @url, @state, @merged_at, @read_at)`).run(row)
}

export function prsOf(db: Db, repo: string): { plan: number; evidence: string }[] {
  return db.prepare(`SELECT d.plan_id AS plan, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*' AND t.repo = ?
    UNION
    SELECT p.id AS plan, t.evidence
    FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE t.evidence GLOB 'https://*/pull/*' AND t.repo = ?
    ORDER BY plan`).all(repo, repo) as { plan: number; evidence: string }[]
}

export function putRecord(db: Db, row: Row): void {
  db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, word_by, word_at, word, read_at, title, opened_at)
    VALUES (@repo, @pr, @plan, @url, @state, @merged_at, @word_by, @word_at, @word, @read_at, @title, @opened_at)
    ON CONFLICT (repo, pr) DO UPDATE SET plan = excluded.plan, url = excluded.url, state = excluded.state,
      merged_at = excluded.merged_at, word_by = excluded.word_by, word_at = excluded.word_at, word = excluded.word,
      read_at = excluded.read_at, title = coalesce(excluded.title, records.title),
      opened_at = coalesce(excluded.opened_at, records.opened_at)`).run(row)
}

export function recordsOf(db: Db, repo: string): Row[] {
  return db.prepare('SELECT * FROM records WHERE repo = ? ORDER BY pr').all(repo) as Row[]
}

export function openRecords(db: Db, repo: string | null): Row[] {
  return db.prepare(`SELECT * FROM records WHERE state = 'OPEN' AND merged_at IS NULL AND (? IS NULL OR repo = ?)
    ORDER BY repo, pr`).all(repo, repo) as Row[]
}

export function still(db: Db, repo: string): number {
  return (db.prepare("SELECT count(*) AS n FROM records WHERE repo = ? AND state = 'OPEN' AND merged_at IS NULL")
    .get(repo) as { n: number }).n
}

export function dropRecord(db: Db, repo: string, pr: number): void {
  db.prepare('DELETE FROM records WHERE repo = ? AND pr = ?').run(repo, pr)
}

export function refusedOf(db: Db, plan: number, limit = 12): Refused[] {
  return db.prepare(`SELECT step, coalesce(rail_id, gate) AS what, outcome, coalesce(message, '') AS message
    FROM verdicts WHERE plan = ? AND outcome <> 'pass' ORDER BY id DESC LIMIT ?`).all(plan, limit) as Refused[]
}
