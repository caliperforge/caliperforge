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

const PROSE: Record<keyof typeof METRICS | 'outside_prs' | 'outside_pr_list' | 'vo_conformance',{ title: string; unit: string; definition: string; caveat: string }> = {
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
  loop_counts: { title: 'Refusals and self-fixes', unit: 'landed jobs, refusals and fix tickets per period',
    definition: "One row per Monday week holding a landed job, then all time, then the 7 UTC days to today. A landed job is a plan in the done state with at least one run, on the UTC day of its newest run. A landed job counts as caliperforge when its target repository's owner is caliperforge or it has no target, and as outside otherwise. Refusals leave out blips, checkouts the network failed: a first-pass job had none, and a rebuilt one had at least one and two or more build runs. Fix tickets are the issues the director filed, the issues the fixer filed, and the origins of plans queued for a repeated stop, each counted once; one has landed when a done plan has it as its origin. Language notes count by the day they were kept, and drift fixes by the day the finding closed as fixed.",
    caveat: 'A fix ticket counts on the day it was first filed, and a period with no landed job has no ratios.' },
  outside_prs: { title: 'Outside pull requests', unit: 'pull requests',
    definition: 'Every pull request we opened outside caliperforge, from GitHub search, one row each: its state (merged, closed, approved when open with an approving review, else open), the class of its repository, and the month it was opened.',
    caveat: 'Search reaches at most 1000 pull requests, and a repository missing from the hand-kept class map counts as other.' },
  outside_pr_list: { title: 'Outside pull requests by name', unit: 'pull requests',
    definition: 'Every pull request we opened outside caliperforge, from GitHub search, one row each: its repository, number, title and link, its state (merged, closed, approved when open with an approving review, else open), the UTC days it was opened and merged, the field of its repository, and the description the repository gives on GitHub.',
    caveat: 'Search reaches at most 1000 pull requests. Merged is null until a pull request merges, and a repository missing from the hand-kept field map has a null field. Titles and descriptions are as their authors wrote them.' },
  vo_conformance: { title: 'VO conformance', unit: 'outcomes per client, service and behaviour per UTC day',
    definition: 'Every row of caliperforge/vo-conformance results/<day>.jsonl for the 30 UTC days to today, in file order: the day, the client, the service, the behaviour, its outcome (pass, fail, not supported or service down) and its note. behaviours holds the README description of each behaviour in the rows, and run_at the commit time of the newest results file.',
    caveat: 'A day the daily run committed no results file has no rows. Notes are as the runner wrote them, and null where it wrote none.' },
}

const LEAK = /cost|usd|price|dollar|funder|email|login/i

export function leaked(value: unknown): string | undefined {
  if (typeof value === 'string') return LEAK.test(value) ? value : undefined
  if (typeof value !== 'object' || value === null) return undefined
  const parts = Array.isArray(value) ? (value as unknown[]) : Object.entries(value as Record<string, unknown>).flat()
  return parts.map(leaked).find((hit) => hit !== undefined)
}

const Page = z.object({ items: z.array(z.object({
  number: z.int(),
  title: z.string(),
  html_url: z.string(),
  repository_url: z.string(),
  state: z.enum(['open', 'closed']),
  created_at: z.string(),
  pull_request: z.object({ merged_at: z.string().nullable() }),
})) })

type Item = z.infer<typeof Page>['items'][number]

const Maps = z.object({
  classes: z.record(z.string(), z.string()),
  fields: z.record(z.string(), z.enum(['payments', 'developer tools', 'astronomy', 'genomics'])),
})

type Listed = [string, number, string, string, string, string, string | null, string | null, string | null]

function searched(q: string, read: Read): Item[] {
  const items: Item[] = []
  for (let n = 1; n <= 10; n++) {
    const page = Page.parse(read(['api', `search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${String(n)}`])).items
    items.push(...page)
    if (page.length < 100) break
  }
  return items
}

const Q = `is:pr author:${OPERATOR} -org:${FORK}`

const repoOf = (i: Item): string => i.repository_url.replace('https://api.github.com/repos/', '')

function outside(read: Read, classes: Record<string, string>): { columns: string[]; rows: [string, string, string][] } {
  const approved = new Set(searched(`${Q} is:open review:approved`, read).map((i) => i.html_url))
  const rows = searched(Q, read).map((i): [string, string, string] => [
    i.pull_request.merged_at !== null ? 'merged' : i.state === 'closed' ? 'closed' : approved.has(i.html_url) ? 'approved' : 'open',
    classes[repoOf(i)] ?? 'other',
    i.created_at.slice(0, 7),
  ])
  rows.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
  return { columns: ['state', 'class', 'month'], rows }
}

function listed(read: Read, fields: Record<string, string>): { columns: string[]; rows: Listed[] } {
  const described = new Map<string, string | null>()
  const description = (repo: string): string | null => {
    if (!described.has(repo)) described.set(repo, z.object({ description: z.string().nullable() }).parse(read(['api', `repos/${repo}`])).description)
    return described.get(repo) ?? null
  }
  const approved = (repo: string, n: number): boolean => z.array(z.object({ state: z.string() }))
    .parse(read(['api', `repos/${repo}/pulls/${String(n)}/reviews?per_page=100`])).some((r) => r.state === 'APPROVED')
  const rows = searched(Q, read).map((i): Listed => {
    const repo = repoOf(i)
    const state = i.pull_request.merged_at !== null ? 'merged' : i.state === 'closed' ? 'closed' : approved(repo, i.number) ? 'approved' : 'open'
    return [repo, i.number, i.title, i.html_url, state, i.created_at.slice(0, 10), i.pull_request.merged_at?.slice(0, 10) ?? null,
      fields[repo] ?? null, description(repo)]
  })
  rows.sort((a, b) => a[5].localeCompare(b[5]) || a[0].localeCompare(b[0]) || a[1] - b[1])
  return { columns: ['repo', 'number', 'title', 'url', 'state', 'opened', 'merged', 'field', 'repo_description'], rows }
}

function file(dir: string, name: keyof typeof PROSE, table: { columns: string[]; rows: unknown[][] }, verbatim: string[] = []): { path: string; body: string } {
  const { title, unit, definition, caveat } = PROSE[name]
  const data = { metric: name, title, unit, ...table, definition, caveat }
  const blank = verbatim.map((column) => table.columns.indexOf(column))
  const leak = leaked({ ...data, rows: table.rows.map((row) => row.map((cell, i) => blank.includes(i) ? null : cell)) })
  if (leak !== undefined) throw new Error(`${name}.json: ${leak}`)
  return { path: join(dir, 'data', `${name}.json`), body: JSON.stringify(data, null, 2) }
}

export function exported(path: string, dir: string, now: Date, read: Read = gh): string[] {
  const db = reader(path)
  try {
    const today = now.toISOString().slice(0, 10)
    const { classes, fields } = Maps.parse(parse(readFileSync(join(import.meta.dirname, '../rules/repo-classes.yaml'), 'utf8')))
    const files = (Object.keys(METRICS) as (keyof typeof METRICS)[]).map((name) => file(dir, name, metric(db, METRICS[name], today)))
    files.push(file(dir, 'outside_prs', outside(read, classes)))
    files.push(file(dir, 'outside_pr_list', listed(read, fields), ['title', 'repo_description']))
    mkdirSync(join(dir, 'data'), { recursive: true })
    for (const f of files) writeFileSync(`${f.path}.tmp`, f.body)
    for (const f of files) renameSync(`${f.path}.tmp`, f.path)
    return files.map((f) => f.path)
  } finally {
    db.close()
  }
}

const VO = 'repos/caliperforge/vo-conformance'

const OUTCOMES = ['pass', 'fail', 'not supported', 'service down'] as const

const Row = z.object({ client: z.string(), service: z.string(), behaviour: z.string(), outcome: z.enum(OUTCOMES), note: z.string().optional() })

function row(raw: unknown): z.infer<typeof Row> {
  const got = Row.safeParse(raw)
  if (got.success) return got.data
  const at = (path: PropertyKey[]): unknown => path.reduce<unknown>((v, k) => (v as Record<PropertyKey, unknown>)[k], raw)
  throw new Error(`vo_conformance.json: ${got.error.issues.map((i) => `${i.path.join('.')} ${JSON.stringify(at(i.path))}: ${i.message}`).join('; ')}`)
}

const decoded = (value: unknown): string =>
  Buffer.from(z.object({ content: z.string(), encoding: z.literal('base64') }).parse(value).content, 'base64').toString('utf8')

export function conformance(dir: string, now: Date, read: Read = gh): string {
  const today = now.toISOString().slice(0, 10)
  const first = new Date(now.getTime() - 29 * 86_400_000).toISOString().slice(0, 10)
  const days = z.array(z.object({ name: z.string() })).parse(read(['api', `${VO}/contents/results`]))
    .flatMap((f) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f.name)?.[1] ?? []).filter((d) => d >= first && d <= today).sort()
  const newest = days.at(-1)
  if (newest === undefined) throw new Error(`vo_conformance.json: no results since ${first}`)
  const parsed = days.flatMap((day) => decoded(read(['api', `${VO}/contents/results/${day}.jsonl`])).split('\n').filter((l) => l.trim() !== '')
    .map((l) => ({ day, ...row(JSON.parse(l)) })))
  const said = new Map([...decoded(read(['api', `${VO}/readme`])).matchAll(/^Behaviour `([^`]+)`: (.+)$/gm)].map((m) => [m[1], m[2]]))
  const behaviours = Object.fromEntries([...new Set(parsed.map((r) => r.behaviour))].map((b) => {
    const description = said.get(b)
    if (description === undefined) throw new Error(`vo_conformance.json: no description for ${b}`)
    return [b, description]
  }))
  const [{ commit }] = z.tuple([z.object({ commit: z.object({ committer: z.object({ date: z.string() }) }) })], z.unknown())
    .parse(read(['api', `${VO}/commits?path=results/${newest}.jsonl&per_page=1`]))
  const rows = parsed.map((r) => [r.day, r.client, r.service, r.behaviour, r.outcome, r.note ?? null])
  const table = { columns: ['day', 'client', 'service', 'behaviour', 'outcome', 'note'], rows, behaviours, run_at: commit.committer.date,
    source: 'https://github.com/caliperforge/vo-conformance/tree/main/results' }
  const f = file(dir, 'vo_conformance', table, ['note'])
  mkdirSync(join(dir, 'data'), { recursive: true })
  writeFileSync(`${f.path}.tmp`, f.body)
  renameSync(`${f.path}.tmp`, f.path)
  return f.path
}

export function registerExport(cf: Command, { root, db, out }: Cli): void {
  cf.command('export').command('metrics').requiredOption('--dir <path>', 'the site checkout').action((options: { dir: string }) => {
    // A read-only handle on a WAL file opens only while a writer keeps its -wal and -shm files.
    db()
    for (const path of exported(join(root, 'cf.db'), options.dir, new Date())) out(`${path}\n`)
  })
}
