import type { Command } from 'commander'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import type { Provider } from '../providers/kind.ts'
import { fire } from '../runner/index.ts'
import { prose } from '../sequencer/prose.ts'
import { file } from '../sequencer/signals.ts'
import { commsLane } from '../store/comms.ts'
import { amend, approved, log, opened, postOf, sentBack, STATUSES, type Item } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { zone } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { holderOf, HOLDERS, plansOf, requeue, type Holder } from '../store/plans.ts'
import { steps } from '../templates/comms.ts'
import type { Cli } from './cf-lanes.ts'

const BY = ['--by <actor>', `who ran it: ${HOLDERS.join(' or ')}`] as const
const DRAFT = steps.findIndex((s) => s.name === 'draft')
const FIELDS = ['title', 'dek', 'body'] as const

export function giveBack(db: Db, id: number, note: string, by: Holder): void {
  if (holder(db, id) !== null) throw new Error(`plan ${String(id)} is mid-step in a live tick; return it once the tick lets go`)
  db.transaction(() => {
    sentBack(db, id, note, by)
    requeue(db, id, DRAFT)
  })()
}

export function learn(db: Db, item: Item, now: Date): number {
  const day = new Date(now.getTime() + zone(db) * 60000).toISOString().slice(0, 10)
  return log(db, day, [{ ...item, source: 'coo' }])
}

const LIVE = ['queued', 'running', 'blocked_on_ceo', 'done']

export function catchup(db: Db, from: string, to: string, by: Holder, now: Date): number {
  const range = `${from} ${to}`
  if (![from, to].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error(`catchup takes dates as YYYY-MM-DD, not ${range}`)
  if (from > to) throw new Error(`catchup ${range}: ${from} is after ${to}`)
  for (const p of plansOf(db, 'comms')) {
    if (!LIVE.includes(p.state) || p.title?.startsWith('catchup ') !== true) continue
    const [, a = '', b = ''] = p.title.split(' ')
    if (from <= b && a <= to) throw new Error(`catchup ${range} overlaps plan ${String(p.id)} ${p.title}`)
  }
  commsLane(db)
  const plan = file(db, `catchup ${range}`, null, now, by, 'cf desk catchup')
  if (plan === null) throw new Error(`catchup ${range} is already filed`)
  return plan
}

const Claims = z.object({ claims: z.array(z.object({ line: z.number().int().positive(), claim: z.string().trim().min(1),
  evidence: z.string().trim().min(1), quote: z.string().nullish() })) })
type Claim = z.infer<typeof Claims>['claims'][number]

const GITHUB = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(commit\/[0-9a-f]{7,40}|actions\/runs\/\d+)$/

function backed(draft: string, { evidence, quote }: Claim): boolean {
  if (evidence === 'none' || !draft.includes(evidence)) return false
  if (GITHUB.test(evidence)) return true
  if (evidence.startsWith('https://')) return quote != null && quote !== '' && draft.includes(quote)
  return statSync(resolve(evidence), { throwIfNoEntry: false })?.isFile() === true
}

export async function claims(db: Db, root: string, draft: string, provider: Provider): Promise<{ text: string; refused: boolean }> {
  const text = readFileSync(draft, 'utf8')
  const parts = (await fire(db, root, 'claims_checker', process.cwd(), text, provider)).text.trimEnd().split(/^---$/m)
  const got = parts.length > 2 && parts.at(-1) === '' ? Claims.safeParse(prose(parts.at(-2) ?? '', ['claim', 'evidence', 'quote'])) : null
  if (got?.success !== true) throw new Error('claims_checker.fence: the reply closes with no parseable claims: fence')
  const rows = got.data.claims.map((c) => ({ ...c, at: `${draft}:${String(c.line)}`, ok: backed(text, c) }))
  const unbacked = rows.filter((r) => !r.ok).map((r) => r.at)
  const last = unbacked.length === 0 ? `pass: ${String(rows.length)} statement(s), each backed` : `refuse: ${unbacked.join(', ')} unbacked`
  return { text: [...rows.map((r) => `${r.at}\t${r.ok ? r.evidence : 'unbacked'}\t${r.claim}`), last].join('\n') + '\n', refused: unbacked.length > 0 }
}

function statusOf(status: string): Item['status'] {
  const hit = STATUSES.find((s) => s === status)
  if (hit === undefined) throw new Error(`--status takes fixed, open, ruled or noted, not ${status}`)
  return hit
}

export function registerDesk(cf: Command, { root, db, out }: Cli): void {
  const desk = cf.command('desk')

  desk.command('list').action(() => {
    for (const p of opened(db())) out(`${String(p.id)}\t${p.kind}\t${p.dest}\t${p.status}\t${p.title}\n`)
  })

  desk.command('show').argument('<id>').action((id: string) => {
    const p = postOf(db(), Number(id))
    out(`${String(p.id)}\t${p.kind}\t${p.dest}\t${p.status}\n\n${p.edited_title ?? p.title}\n\n${p.edited_dek ?? p.dek}\n\n${p.edited_body ?? p.body}\n`
      + (p.note === null ? '' : `\nnote: ${p.note}\n`))
  })

  desk.command('edit').argument('<id>').option('--title <file>', 'the new title')
    .option('--dek <file>', 'the new dek').option('--body <file>', 'the new body').requiredOption(...BY)
    .action((id: string, options: Partial<Record<typeof FIELDS[number], string>> & { by: string }) => {
      const by = holderOf(options.by)
      const fields = Object.fromEntries(FIELDS.flatMap((f) => options[f] === undefined ? [] : [[f, readFileSync(options[f], 'utf8')]]))
      if (Object.keys(fields).length === 0) throw new Error('desk edit takes --title, --dek or --body')
      amend(db(), Number(id), fields, by)
      out(`desk post ${id} edited\n`)
    })

  desk.command('approve').argument('<id>').requiredOption(...BY).action((id: string, options: { by: string }) => {
    const by = holderOf(options.by)
    approved(db(), Number(id), by)
    out(`desk post ${id} approved\n`)
  })

  desk.command('return').argument('<id>').requiredOption('--note <text>', 'what the writer changes').requiredOption(...BY)
    .action((id: string, options: { note: string; by: string }) => {
      const by = holderOf(options.by)
      giveBack(db(), Number(id), options.note, by)
      out(`desk post ${id} returned; plan ${id} queued at step ${String(DRAFT)}\n`)
    })

  registerCatchup(desk, { db, out })
  registerClaims(desk, { root, db, out })
  registerLearn(cf, { db, out })
}

function registerCatchup(desk: Command, { db, out }: Pick<Cli, 'db' | 'out'>): void {
  desk.command('catchup').argument('<from>').argument('<to>').requiredOption(...BY)
    .action((from: string, to: string, options: { by: string }) => {
      const by = holderOf(options.by)
      out(`${String(catchup(db(), from, to, by, new Date()))}\n`)
    })
}

function registerClaims(desk: Command, { root, db, out }: Cli): void {
  desk.command('claims').argument('<draft>').action(async (draft: string) => {
    const { text, refused } = await claims(db(), root, draft, claudeAgentSdk)
    out(text)
    process.exitCode = refused ? 1 : 0
  })
}

function registerLearn(cf: Command, { db, out }: Pick<Cli, 'db' | 'out'>): void {
  cf.command('learn').argument('<title>').option('--what <text>', 'what happened', '').option('--lesson <text>', 'the lesson', '')
    .option('--fix <text>', 'the fix', '').option('--status <status>', STATUSES.join(', '), 'noted')
    .action((title: string, options: { what: string; lesson: string; fix: string; status: string }) => {
      const status = statusOf(options.status)
      out(`${String(learn(db(), { title, what: options.what, lesson: options.lesson, fix: options.fix, status }, new Date()))} item(s) added\n`)
    })
}
