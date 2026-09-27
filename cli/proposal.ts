import type { Db } from '../store/index.ts'
import { render as renderRecord, still, type Row } from './record.ts'
import { render as renderScan } from './scan.ts'

export function askFor(db: Db, target: number): string {
  const t = db.prepare('SELECT repo, state FROM targets WHERE id = ?').get(target) as { repo: string; state: string } | undefined
  if (t?.state !== 'ready') throw new Error(`target ${String(target)} is not ready`)
  const rows = db.prepare('SELECT * FROM records WHERE repo = ? ORDER BY pr').all(t.repo) as Row[]
  if (!rows.some((r) => r.merged_at !== null)) throw new Error(`${t.repo} has no merged pull request on record`)
  return `# Target\n\n${renderScan(db, target)}\n# Record\n\n${renderRecord(t.repo, rows, still(db, t.repo))}`
}

export function cites(card: string, rows: Row[]): string {
  const url = /^\*\*Shape:\*\*.*?(https:\/\/\S+)/m.exec(card)?.[1]
  if (url === undefined || !rows.some((r) => r.url === url && r.merged_at !== null)) {
    throw new Error('the card cites no merged pull request on record')
  }
  return url
}
