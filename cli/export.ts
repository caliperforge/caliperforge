import type { Command } from 'commander'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { FORK, OPERATOR } from '../sequencer/workspace.ts'
import { metric, METRICS, reader } from '../store/metrics.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, type Read } from './gh.ts'

const SPLIT = 'input is input_tokens less cache_write_tokens, since input_tokens counts cache writes; cache_read, cache_write and output are their own columns; total is input_tokens + cache_read_tokens + output_tokens, the sum of the four.'

const PROSE: Record<keyof typeof METRICS | 'outside_prs', { title: string; unit: string; definition: string; caveat: string }> = {
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
  tokens_per_landed_job: { title: 'Tokens per landed job', unit: 'tokens per job, by week queued',
    definition: "Every plan in the done state with at least one run, grouped by the week it was queued, each week labelled by its Monday. A job's tokens are the sum over all its runs, rework included; fresh is input_tokens + output_tokens, and total is fresh plus cache_read_tokens.",
    caveat: 'Cohorts are by the week a job was queued, and count landed jobs only.' },
  ceo_touches: { title: 'Human touches', unit: 'CEO actions per UTC day',
    definition: "Every event the CEO logged, by the UTC day it was recorded, from the first CEO event's day to today, counted by kind. A kind outside the eight listed counts as other.",
    caveat: 'A day with no CEO events is a row of zeros, and today is a partial day. It counts actions, not time spent.' },
  outside_prs: { title: 'Outside pull requests', unit: 'pull requests',
    definition: 'Every pull request we opened outside caliperforge, from GitHub search, one row each: its state (merged, closed, approved when open with an approving review, else open), the class of its repository, and the month it was opened.',
    caveat: 'Search reaches at most 1000 pull requests, and a repository missing from the hand-kept class map counts as other.' },
}

const LEAK = /cost|usd|price|dollar|funder|email|login/i

export function leaked(value: unknown): string | undefined {
  if (typeof value === 'string') return LEAK.test(value) ? value : undefined
  if (typeof value !== 'object' || value === null) return undefined
  const parts = Array.isArray(value) ? (value as unknown[]) : Object.entries(value as Record<string, unknown>).flat()
  return parts.map(leaked).find((hit) => hit !== undefined)
}

const Page = z.object({ items: z.array(z.object({
  html_url: z.string(),
  repository_url: z.string(),
  state: z.enum(['open', 'closed']),
  created_at: z.string(),
  pull_request: z.object({ merged_at: z.string().nullable() }),
})) })

type Item = z.infer<typeof Page>['items'][number]

function searched(q: string, read: Read): Item[] {
  const items: Item[] = []
  for (let n = 1; n <= 10; n++) {
    const page = Page.parse(read(['api', `search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${String(n)}`])).items
    items.push(...page)
    if (page.length < 100) break
  }
  return items
}

function outside(read: Read): { columns: string[]; rows: [string, string, string][] } {
  const q = `is:pr author:${OPERATOR} -org:${FORK}`
  const approved = new Set(searched(`${q} is:open review:approved`, read).map((i) => i.html_url))
  const classes = z.record(z.string(), z.string()).parse(parse(readFileSync(join(import.meta.dirname, '../rules/repo-classes.yaml'), 'utf8')))
  const rows = searched(q, read).map((i): [string, string, string] => [
    i.pull_request.merged_at !== null ? 'merged' : i.state === 'closed' ? 'closed' : approved.has(i.html_url) ? 'approved' : 'open',
    classes[i.repository_url.replace('https://api.github.com/repos/', '')] ?? 'other',
    i.created_at.slice(0, 7),
  ])
  rows.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  return { columns: ['state', 'class', 'month'], rows }
}

function file(dir: string, name: keyof typeof PROSE, table: { columns: string[]; rows: unknown[][] }): { path: string; body: string } {
  const { title, unit, definition, caveat } = PROSE[name]
  const data = { metric: name, title, unit, ...table, definition, caveat }
  const leak = leaked(data)
  if (leak !== undefined) throw new Error(`${name}.json: ${leak}`)
  return { path: join(dir, 'data', `${name}.json`), body: JSON.stringify(data, null, 2) }
}

export function exported(path: string, dir: string, now: Date, read: Read = gh): string[] {
  const db = reader(path)
  try {
    const today = now.toISOString().slice(0, 10)
    const files = (Object.keys(METRICS) as (keyof typeof METRICS)[]).map((name) => file(dir, name, metric(db, METRICS[name], today)))
    files.push(file(dir, 'outside_prs', outside(read)))
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
