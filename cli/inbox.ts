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
export type Kind = 'blocked' | 'landed' | 'done' | 'refused' | 'asked' | 'signoff'

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
  return `${clock(new Date(e.at), zone(db))}  ${e.kind.padEnd(7)}  ${e.ticket} (plan ${String(e.plan)}) at step ${String(e.step)} ${e.name}: ${e.note}`
}

/** Blocked, landed, done, an ask and a card to sign reach the desktop; a refusal going round again only reaches the file. */
export function notify(news: Event[], post: Post = desktop): void {
  for (const e of news.filter((n) => LOUD.has(n.kind))) post(`cf: ${e.ticket} ${e.kind}`, e.note)
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
