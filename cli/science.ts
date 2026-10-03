import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { get, zone } from '../store/lanes.ts'
import { DAILY, daily } from '../store/science.ts'

const DAY = 86400000

const shift = (day: string, days: number): string => new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10)

export function pull(db: Db, now: Date, since?: string): string[] {
  const value = get(db, 'science.dir')
  const dir = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (dir === '' || !existsSync(dir)) {
    logged(db, { plan: null, kind: 'science_pull', actor: 'science', outcome: 'refuse',
      message: dir === '' ? 'science.dir is unset' : `science.dir ${dir} does not exist`, pointer: null, run: null })
    return []
  }
  const offset = zone(db)
  const today = new Date(now.getTime() + offset * 60000).toISOString().slice(0, 10)
  const days = { zone: offset, since: since ?? shift(today, -7), today }
  const out = join(dir, 'data/v2')
  mkdirSync(out, { recursive: true })
  const csvs = Object.entries(DAILY).map(([name, sql]) => {
    const { columns, rows } = daily(db, sql, days)
    const query = `"${sql.replaceAll('"', '""')}"`
    return put(join(out, `${name}.csv`), [`${columns.join(',')},query`,
      ...rows.map((r) => `${r.map((c) => String(c ?? '')).join(',')},${query}`)])
  })
  return [...csvs, put(join(out, 'due.md'), due(join(dir, 'data/interventions_v2.csv'), today))]
}

function put(path: string, lines: string[]): string {
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

function due(path: string, today: string): string[] {
  if (!existsSync(path)) return ['no data/interventions_v2.csv']
  const [head = [], ...rows] = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l !== '').map(cells)
  const at = head.indexOf('review_date')
  const until = shift(today, 7)
  const hits = rows.filter((r) => today <= (r[at] ?? '') && (r[at] ?? '') < until)
  return [row(head), row(head.map(() => '---')), ...(hits.length === 0 ? ['none'] : hits.map(row))]
}

function cells(line: string): string[] {
  return [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) => m[1]?.replaceAll('""', '"') ?? m[2] ?? '')
}

const row = (r: string[]): string => `| ${r.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`
