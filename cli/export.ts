import type { Command } from 'commander'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { metric, METRICS, reader } from '../store/metrics.ts'
import type { Cli } from './cf-lanes.ts'

const SPLIT = 'input is input_tokens less cache_write_tokens, since input_tokens counts cache writes; cache_read, cache_write and output are their own columns; total is input_tokens + cache_read_tokens + output_tokens, the sum of the four.'

const PROSE: Record<keyof typeof METRICS, { title: string; unit: string; definition: string; caveat: string }> = {
  daily_activity: { title: 'Daily activity', unit: 'runs and tokens per UTC day',
    definition: `Every agent run, by the UTC day it was recorded, from the first run's day to today. ${SPLIT}`,
    caveat: 'A day with no runs is a row of zeros, and today is a partial day.' },
  token_mix: { title: 'Token mix', unit: 'tokens', definition: `Tokens over every agent run, split four ways. ${SPLIT}`,
    caveat: 'A run that recorded no cache writes counts them as input.' },
  runs_by_seat: { title: 'Runs by seat', unit: 'runs', definition: 'Every agent run, counted by the seat that ran it, highest first.',
    caveat: 'A retried or reworked step counts as another run.' },
}

export function exported(path: string, dir: string, now: Date): string[] {
  const db = reader(path)
  try {
    const today = now.toISOString().slice(0, 10)
    const files = (Object.keys(METRICS) as (keyof typeof METRICS)[]).map((name) => {
      const { title, unit, definition, caveat } = PROSE[name]
      const body = JSON.stringify({ metric: name, title, unit, ...metric(db, METRICS[name], today), definition, caveat }, null, 2)
      return { path: join(dir, 'data', `${name}.json`), body }
    })
    mkdirSync(join(dir, 'data'), { recursive: true })
    for (const f of files) writeFileSync(`${f.path}.tmp`, f.body)
    for (const f of files) renameSync(`${f.path}.tmp`, f.path)
    return files.map((f) => f.path)
  } finally {
    db.close()
  }
}

export function registerExport(cf: Command, { root, db, out }: Cli): void {
  cf.command('export').command('metrics').requiredOption('--dir <path>', 'the site checkout').action((options: { dir: string }) => {
    // A read-only handle on a WAL file opens only while a writer keeps its -wal and -shm files.
    db()
    for (const path of exported(join(root, 'cf.db'), options.dir, new Date())) out(`${path}\n`)
  })
}
