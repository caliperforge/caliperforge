import type { Db } from '../store/index.ts'
import { recordsOf } from '../store/record.ts'
import { readyRepo } from '../store/targets.ts'
import { render as renderRecord, still, type Row } from './record.ts'
import { render as renderScan } from './scan.ts'

export function askFor(db: Db, target: number): string {
  const repo = readyRepo(db, target)
  if (repo === null) throw new Error(`target ${String(target)} is not ready`)
  const rows = recordsOf(db, repo)
  if (!rows.some((r) => r.merged_at !== null)) throw new Error(`${repo} has no merged pull request on record`)
  return `# Target\n\n${renderScan(db, target)}\n# Record\n\n${renderRecord(repo, rows, still(db, repo))}`
}

export function cites(card: string, rows: Row[]): string {
  const url = /^\*\*Shape:\*\*.*?(https:\/\/\S+)/m.exec(card)?.[1]
  if (url === undefined || !rows.some((r) => r.url === url && r.merged_at !== null)) {
    throw new Error('the card cites no merged pull request on record')
  }
  return url
}
