import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Fired } from '../sequencer/kind.ts'
import type { Db } from '../store/index.ts'
import { zone } from '../store/lanes.ts'
import { clock } from '../store/plans.ts'

/**
 * #49: what a tick did that a person may have to act on, as one line per event in a file the COO
 * reads at every check-in (`cf inbox`), and a desktop notification for the ones that need one.
 * Read is what `cf inbox --ack` has marked; nothing else counts as delivered.
 */
export type Kind = 'blocked' | 'landed' | 'done' | 'refused' | 'asked' | 'signoff' | 'crashed'

export interface Event {
  at: string
  plan: number
  ticket: string
  kind: Kind
  step: number
  name: string
  note: string
}

const INBOX = '.cf/inbox.jsonl'

const READ = '.cf/inbox.read'

const LOUD = new Set<Kind>(['blocked', 'landed', 'done', 'asked', 'signoff'])

export type Post = (title: string, body: string) => void

export function events(db: Db, fired: Fired[], at: string): Event[] {
  return fired.flatMap((f) => {
    const kind = kindOf(f)
    return kind === null ? [] : [{ at, plan: f.plan, ticket: ticketOf(db, f.plan), kind, step: f.step, name: f.name, note: f.note }]
  })
}

function kindOf(f: Fired): Kind | null {
  if (f.state === 'blocked_on_ceo') return 'blocked'
  if (f.note.startsWith('landed ')) return 'landed'
  if (f.state === 'done') return 'done'
  return f.outcome === 'refuse' ? 'refused' : null
}

function ticketOf(db: Db, plan: number): string {
  const row = db.prepare(`SELECT p.origin, t.repo, t.issue_no FROM plans p LEFT JOIN targets t ON t.id = p.target_id
    WHERE p.id = ?`).get(plan) as { origin: string | null; repo: string | null; issue_no: number | null } | undefined
  if (row?.origin != null) return `#${row.origin.split('/').at(-1) ?? ''}`
  return row?.repo == null ? `plan ${String(plan)}` : `${row.repo}#${String(row.issue_no)}`
}

export function record(root: string, news: Event[]): void {
  if (news.length === 0) return
  const path = join(root, INBOX)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, news.map((e) => `${JSON.stringify(e)}\n`).join(''))
}

export function crashed(root: string, at: string, error: unknown): void {
  const note = error instanceof Error ? error.message : String(error)
  record(root, [{ at, plan: 0, ticket: 'cf tick', kind: 'crashed', step: 0, name: 'tick', note }])
}

export function unread(root: string): Event[] {
  return all(root).slice(seen(root))
}

export function ack(root: string): number {
  const count = all(root).length
  const marked = count - seen(root)
  writeFileSync(join(root, READ), `${String(count)}\n`)
  return marked
}

function all(root: string): Event[] {
  const path = join(root, INBOX)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Event)
}

function seen(root: string): number {
  const path = join(root, READ)
  return existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : 0
}

export function line(db: Db, e: Event): string {
  const where = e.kind === 'crashed' ? e.ticket : `${e.ticket} (plan ${String(e.plan)}) at step ${String(e.step)} ${e.name}`
  return `${clock(new Date(e.at), zone(db))}  ${e.kind.padEnd(7)}  ${where}: ${e.note}`
}

/** Blocked, landed, done, an ask and a card to sign reach the desktop; a refusal going round again only reaches the file. */
export function notify(news: Event[], post: Post = desktop): void {
  for (const e of news.filter((n) => LOUD.has(n.kind))) post(`CaliperForge · ${short(e.ticket)}`, plain(e))
}

const HEAD: Record<Kind, string> = {
  blocked: 'Stopped, needs you',
  landed: 'Landed on main',
  done: 'Done',
  refused: 'Sent back',
  asked: 'Someone commented on the PR',
  signoff: 'Ready for your review before it posts',
  crashed: 'The tick crashed',
}

/** Why a job stopped, in the words a person reads on a phone; an unknown reason falls back to the machine's note. */
const WHY: [RegExp, string][] = [
  [/token ceiling|past the [\d.]+M ceiling/, 'it spent past the job ceiling; send it round again or drop it'],
  [/run\.token_wall/, 'one run hit the spend wall'],
  [/run\.idle/, 'the builder read for a long time and wrote nothing'],
  [/verdict_fence|reviewers\.verdict/, 'the reviewer gave no verdict'],
  [/same refusal came back/, 'the same problem came back twice, so it stopped rather than loop'],
  [/exit \d+$/, 'a step failed'],
]

/** The note a person gets: the stop reason in words and the step it stopped at; HTML a bot posted is stripped. */
export function plain(e: Event): string {
  const note = e.note.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (e.kind !== 'blocked') return `${HEAD[e.kind]}. ${note}`.trim()
  const why = WHY.find(([pattern]) => pattern.test(e.note))?.[1] ?? note
  return `${HEAD.blocked}: ${why} (at ${e.name}).`
}

function short(ticket: string): string {
  return ticket.replace(/^[\w.-]+\/([\w.-]+)#/, '$1 #')
}

function desktop(title: string, body: string): void {
  if (process.platform !== 'darwin' || process.env.VITEST !== undefined) return
  const quote = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').slice(0, 180))
  try {
    execFileSync('osascript', ['-e', `display notification ${quote(body)} with title ${quote(title)}`], { stdio: 'ignore' })
  } catch {
    return
  }
}
