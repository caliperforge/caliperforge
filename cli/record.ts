import { BOT } from '../sequencer/capture.ts'
import type { Db } from '../store/index.ts'
import { pr as readPr, prNumber, type Pr } from './gh.ts'

export interface Row {
  repo: string
  pr: number
  plan: number
  url: string
  state: string
  merged_at: string | null
  word_by: string | null
  word_at: string | null
  word: string | null
  read_at: string
}

interface Word { by: string; at: string; text: string }

export function fill(db: Db, repo: string, read: (repo: string, no: number) => Pr = readPr): Row[] {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`"${repo}" is not owner/repo`)
  const ours = db.prepare(`SELECT d.plan_id AS plan, d.evidence
    FROM deliverables d JOIN plans p ON p.id = d.plan_id JOIN targets t ON t.id = p.target_id
    WHERE d.state = 'pushed' AND d.evidence GLOB 'https://*/pull/*' AND t.repo = ?
    UNION
    SELECT p.id AS plan, t.evidence
    FROM plans p JOIN targets t ON t.id = p.target_id
    WHERE t.evidence GLOB 'https://*/pull/*' AND t.repo = ?
    ORDER BY plan`).all(repo, repo) as { plan: number; evidence: string }[]
  const upsert = db.prepare(`INSERT INTO records (repo, pr, plan, url, state, merged_at, word_by, word_at, word, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, pr) DO UPDATE SET plan = excluded.plan, url = excluded.url, state = excluded.state,
      merged_at = excluded.merged_at, word_by = excluded.word_by, word_at = excluded.word_at, word = excluded.word,
      read_at = excluded.read_at`)
  for (const o of ours) {
    const view = read(repo, prNumber(o.evidence))
    const last = word(view)
    upsert.run(repo, view.number, o.plan, view.url, view.state, view.mergedAt, last?.by ?? null, last?.at ?? null,
      last?.text ?? null, new Date().toISOString())
  }
  return db.prepare('SELECT * FROM records WHERE repo = ? ORDER BY pr').all(repo) as Row[]
}

function word(view: Pr): Word | null {
  const theirs = (w: Word): boolean => w.by !== view.author?.login && !BOT.test(w.by)
  return [
    ...view.comments.map((c) => ({ by: c.author.login, at: c.createdAt, text: c.body.trim() })),
    ...view.reviews.map((r) => ({ by: r.author.login, at: r.submittedAt, text: r.body.trim() === '' ? r.state ?? '' : r.body.trim() })),
  ].filter(theirs).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null
}

export function still(db: Db, repo: string): number {
  return (db.prepare("SELECT count(*) AS n FROM records WHERE repo = ? AND state = 'OPEN' AND merged_at IS NULL")
    .get(repo) as { n: number }).n
}

export function render(repo: string, rows: Row[], open: number): string {
  return `${repo}\topen ${String(open)}\n` + rows.map((r) => {
    const said = r.word_by === null || r.word === null ? '-' : `${r.word_by}: ${r.word.replace(/\n[\s\S]*/, '').slice(0, 100)}`
    return `#${String(r.pr)}\t${r.state}\tplan ${String(r.plan)}\t${said}\t${r.url}\n`
  }).join('')
}
