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
  gate_verdicts: { title: 'Gate verdicts', unit: 'verdicts',
    definition: 'Every verdict at pre_review (the rails), review, senior_review, blind_review and ready, counted by outcome, in the order a job meets the gates.',
    caveat: 'A job that is refused and rebuilt is gated again, so these count verdicts, not jobs.' },
  plan_outcomes: { title: 'Plan outcomes', unit: 'plans', definition: 'Every plan, counted by its template and the state it is in now.',
    caveat: 'A plan still queued or running counts in that state until it ends.' },
  pipeline_counts: { title: 'Pipeline counts', unit: 'per stage, as its unit column says',
    definition: 'Each stage a job passes, in order: brief writer runs, specialist build runs, verdicts at the rails, code review, senior review and ready with the refusals among them, CEO approvals, and deliverables pushed.',
    caveat: 'Rails, reviews and ready count verdicts, not jobs: a job that is refused and rebuilt is gated again.' },
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
