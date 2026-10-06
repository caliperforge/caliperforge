import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Landed } from '../cli/batch.ts'
import { record, ticketOf } from '../cli/inbox.ts'
import type { Fired, Provider } from '../providers/kind.ts'
import { read } from '../reviews/verdict.ts'
import { CLOSING, listed, merged, subject } from '../sequencer/daily.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { packed } from '../sequencer/pack.ts'
import { prose } from '../sequencer/prose.ts'
import { ran } from '../sequencer/seat.ts'
import { staffed } from '../sequencer/staffing.ts'
import { scripted, shift, sound, weekly } from '../sequencer/weekly.ts'
import { get, maybe, put } from '../sequencer/workspace.ts'
import { edited, returned } from '../store/desk.ts'
import type { Run } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { packetOf } from '../store/packet.ts'
import type { PlanRow } from '../store/plans.ts'
import { ROOT, type Step } from './pr-path.ts'

const SEATED = new Set(['draft', 'text_review', 'grow'])

function row(name: string, step: number): Step {
  const seat = staffed(ROOT, 'comms', step, null)?.seat
  if (seat === undefined) throw new Error(`comms step ${String(step)} ${name} has no seat in rules/staffing.yaml`)
  const fires = SEATED.has(name) ? 'seat' : 'kernel'
  return { step, name, seat, fires, runs: fires === 'seat' ? seat : name, gate: false, writes_verdict: false, verdict_gate: null }
}

/** A merge signal opens one of these. P7 fills the write-up and its voice fixtures. */
export const steps: Step[] = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score'].map((name, i) => row(name, i))

export function gather(db: Db, root: string, plan: PlanRow): Outcome {
  const week = titled(db, plan, 'weekly')
  if (week !== null) return weekly(db, root, plan, week.slice('weekly '.length))
  const packet = packetOf(db, plan.id)
  put(root, plan.id, 'packet.json', JSON.stringify(packet))
  return { outcome: 'pass', spans: [], note: `${String(packet.landed.length)} landed, ${String(packet.refusals.length)} refused` }
}

export function facts(root: string, plan: PlanRow): Outcome {
  const draft = maybe(root, plan.id, 'draft.md')
  if (draft === null) return { outcome: 'pass', spans: [], note: 'no draft' }
  const { landed, refusals = [] } = JSON.parse(get(root, plan.id, 'packet.json')) as { landed?: Landed[]; refusals?: { id: number }[] }
  const known = landed === undefined ? null
    : new Set([...landed.map((l) => `landed:${String(l.plan)}`), ...refusals.map((r) => `refusal:${String(r.id)}`)])
  const { sources } = JSON.parse(maybe(root, plan.id, 'fence.json') ?? '{"sources":[]}') as { sources: { claim: string; ref: string }[] }
  const numbers = new Set(sources.flatMap((s) => s.claim.match(/\d+/g) ?? []))
  const spans = [...sources.filter((s) => known?.has(s.ref) === false).map((s) => `fence.json:${s.ref}`), ...draft.split('\n').flatMap((line, i) =>
    line.trim() === '' || sound(line, numbers) ? [] : [`draft.md:${String(i + 1)}`])]
  if (spans.length === 0) return { outcome: 'pass', spans, note: 'every source is in the packet and every number in a source claim' }
  return { outcome: 'refuse', spans, note: `${String(spans.length)} span(s) cite a ref the packet lacks, or carry an inline tag, an unclaimed number, an issue or an outside login` }
}

const REF = /^(https:\/\/\S+|[\w-][\w./-]*:[1-9]\d*)$/

const Fence = z.object({
  learnings: z.string().trim().min(1),
  dest: z.enum(['site', 'substack', 'note']),
  dek: z.string().trim().min(1).max(160).regex(/^[^`*_#[\]<>~]*$/),
  sources: z.array(z.object({ claim: z.string().trim().min(1), ref: z.string().regex(REF) })),
  checks: z.array(z.object({ label: z.string().trim().min(1), ok: z.boolean() })),
})

export function drafted(reply: string): (z.infer<typeof Fence> & { post: string }) | null {
  const fence = CLOSING.exec(reply)
  if (fence === null) return null
  const got = Fence.safeParse(prose(fence[1] ?? '', ['learnings', 'dek']))
  return got.success ? { ...got.data, post: reply.slice(0, fence.index).trim() } : null
}

const Stored = Fence.extend({ learnings: z.string().optional() })

export function desk(db: Db, root: string, plan: PlanRow): Outcome {
  const draft = maybe(root, plan.id, 'draft.md')
  if (draft === null) return merged(db, root, plan)
  const fence = Stored.safeParse(JSON.parse(maybe(root, plan.id, 'fence.json') ?? 'null'))
  if (!fence.success) return { outcome: 'refuse', spans: ['fence.json'], note: 'fence.json is missing or lacks a post field' }
  const post = /^# (.+)\n([\s\S]*)$/.exec(draft)
  const body = post?.[2]?.trim() ?? ''
  if (post === null || body === '') return { outcome: 'refuse', spans: ['draft.md'], note: 'draft.md has no # title line or no body' }
  const { title } = db.prepare('SELECT title FROM plans WHERE id = ?').get(plan.id) as { title: string | null }
  if (title === null) return { outcome: 'refuse', spans: ['plans'], note: `plan ${String(plan.id)} has no title` }
  const { dest, dek, sources, checks, learnings = '' } = fence.data
  const work = /\d{4}-\d{2}-\d{2}$/.exec(title)?.[0] ?? plan.queued_at.slice(0, 10)
  db.transaction(() => {
    const added = db.prepare(`INSERT OR IGNORE INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date, proof_at)
      VALUES (?, ?, ?, 'proof', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(plan.id, title.split(' ')[0], dest, (post[1] ?? '').trim(), dek, body,
      JSON.stringify(sources), JSON.stringify(checks), work, new Date().toISOString().slice(0, 10))
    if (added.changes === 0) return
    const old = db.prepare('SELECT items, sources FROM desk_learnings WHERE date = ?').get(work) as { items: string; sources: string } | undefined
    const items = [...JSON.parse(old?.items ?? '[]') as unknown[], ...learnings.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      .map((line) => ({ title: line, what: '', lesson: '', fix: '', status: 'noted' }))]
    const refs = [...new Set([...JSON.parse(old?.sources ?? '[]') as string[], ...sources.map((s) => s.ref)])]
    db.prepare(`INSERT INTO desk_learnings (date, numbers, items, sources) VALUES (?, '[]', ?, ?)
      ON CONFLICT (date) DO UPDATE SET items = excluded.items, sources = excluded.sources`).run(work, JSON.stringify(items), JSON.stringify(refs))
  })()
  return { outcome: 'pass', spans: [], note: `desk_posts ${String(plan.id)} in proof for ${work}` }
}

export function titled(db: Db, plan: PlanRow, kind: string): string | null {
  const { title } = db.prepare('SELECT title FROM plans WHERE id = ?').get(plan.id) as { title: string | null }
  return title?.startsWith(`${kind} `) === true ? title : null
}

const grown = (db: Db, plan: PlanRow): string | null => titled(db, plan, 'growth') ?? titled(db, plan, 'weekly')

export async function grow(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (grown(db, plan) === null) return { outcome: 'pass', spans: [], note: 'skipped: not a growth or weekly plan' }
  const fired = await ran(db, root, plan, step, provider, `# packet.json\n\n${get(root, plan.id, 'packet.json')}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  put(root, plan.id, 'growth.md', fired.text)
  return { outcome: 'pass', spans: [], note: `${step.runs}: growth.md written` }
}

const halted = (step: Step, fired: Fired): Outcome => ({ outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` })

const MODES: Record<string, Run['mode']> = { daily: 'log', ship: 'ship', weekly: 'weekly' }

export async function draft(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const title = titled(db, plan, 'daily') ?? titled(db, plan, 'ship') ?? titled(db, plan, 'weekly')
  if (title === null) return { outcome: 'pass', spans: [], note: 'not a post plan' }
  const fired = await ran(db, root, plan, { ...step, mode: MODES[title.slice(0, title.indexOf(' '))] }, provider, `# packet.json\n\n${get(root, plan.id, 'packet.json')}${returned(db, plan.id)?.replace(/^/, '\n\n# Returned from the desk\n\n') ?? ''}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  if (titled(db, plan, 'daily') !== null) return listed(root, plan, step, fired.text)
  const reply = drafted(fired.text)
  if (reply === null || !scripted(title, reply)) {
    return { outcome: 'refuse', spans: ['writer.fence'], note: `${step.runs} reply has no valid closing fence, or a weekly one no substack dest or ## Script` }
  }
  put(root, plan.id, 'draft.md', reply.post)
  put(root, plan.id, 'fence.json', JSON.stringify({ ...reply, post: undefined }))
  return { outcome: 'pass', spans: [], note: `${step.runs}: draft.md written` }
}

export async function review(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const [name, post] = subject(root, plan.id)
  if (post === null) return { outcome: 'pass', spans: [], note: 'skipped: no draft' }
  const fired = await ran(db, root, plan, step, provider, `# ${name}\n\n${post}\n\n# packet.json\n\n${get(root, plan.id, 'packet.json')}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  const judged = read(fired.text, post)
  if (judged === null) return { outcome: 'refuse', spans: ['text_review.fence'], note: `${step.runs} reply has no valid verdict fence` }
  if (judged.outcome === 'refuse') return { outcome: 'refuse', spans: judged.spans, note: judged.message, to: 1 }
  if (judged.outcome === 'needs_ceo') return { outcome: 'needs_ceo', spans: [], note: judged.message }
  put(root, plan.id, 'review.md', judged.message)
  return { outcome: 'pass', spans: [], note: `${step.runs}: review.md written` }
}

/** A weekly plan's post already holds its plan id on the desk, so its pack row sits this far above it. */
const PACK = 2_000_000

export function pack(db: Db, root: string, plan: PlanRow): Outcome {
  const title = grown(db, plan)
  if (title === null) return { outcome: 'pass', spans: [], note: 'skipped: not a growth or weekly plan' }
  const got = packed(maybe(root, plan.id, 'growth.md') ?? '')
  if (got === null) return { outcome: 'refuse', spans: ['growth.md'], note: 'growth.md has no fence of a topic, 14 Notes of 31–60 words with no ?, replies and partners' }
  const { topic, notes, replies, partners } = got
  const work = /\d{4}-\d{2}-\d{2}$/.exec(title)?.[0] ?? plan.queued_at.slice(0, 10)
  const id = title.startsWith('weekly ') ? PACK + plan.id : plan.id
  db.prepare(`INSERT OR IGNORE INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date, proof_at)
    VALUES (?, 'growth', 'pack', 'proof', ?, '', ?, '[]', '[]', ?, ?, datetime('now'))`)
    .run(id, topic, JSON.stringify({ notes, replies, partners }), work, new Date().toISOString().slice(0, 10))
  return { outcome: 'pass', spans: [], note: `desk_posts ${String(id)} pack in proof for ${work}` }
}

export const SCORECARD_COLUMNS = { subscribers: 'Subscribers', open_rate: 'Open rate', sources: 'Source' }

const STATS = '.cf/growth/stats'

interface Stats { subscribers: number; open_rate: number; sources: Record<string, number> | 'not in export'; swaps: number | null }

function stats(root: string, day: string): Stats | Outcome {
  const [head = [], ...rows] = readFileSync(join(root, STATS, `${day}.csv`), 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => l.split(',').map((cell) => cell.trim()))
  const missing = [SCORECARD_COLUMNS.subscribers, SCORECARD_COLUMNS.open_rate].filter((h) => !head.includes(h))
  if (missing.length > 0) return { outcome: 'refuse', spans: [`${STATS}/${day}.csv`], note: `${day}.csv has no ${missing.join(' or ')} column` }
  const cell = (header: string): string => rows.at(-1)?.[head.indexOf(header)] ?? ''
  const source = head.indexOf(SCORECARD_COLUMNS.sources)
  const swaps = join(root, STATS, `${day}.swaps`)
  return {
    subscribers: Number(cell(SCORECARD_COLUMNS.subscribers)),
    open_rate: Number(cell(SCORECARD_COLUMNS.open_rate).replace('%', '')),
    sources: source === -1 ? 'not in export' : rows.map((r) => r[source] ?? '').filter((s) => s !== '')
      .reduce<Record<string, number>>((n, s) => ({ ...n, [s]: (n[s] ?? 0) + 1 }), {}),
    swaps: existsSync(swaps) ? Number(readFileSync(swaps, 'utf8').trim()) : null,
  }
}

type Card = Stats & { post_by_friday: 'y' | 'n'; notes_ready: number }

function card(db: Db, week: string, got: Stats): Card & { change: Record<string, number | null> | null } {
  const post = db.prepare("SELECT 1 FROM desk_posts WHERE dest = 'substack' AND date(proof_at) BETWEEN ? AND ?").get(week, shift(week, 4))
  const packs = db.prepare(`SELECT COALESCE(edited_body, body) AS body FROM desk_posts
    WHERE kind = 'growth' AND dest = 'pack' AND work_date BETWEEN ? AND ?`).all(week, shift(week, 6)) as { body: string }[]
  const notes = packs.reduce((n, p) => n + (JSON.parse(p.body) as { notes: string[] }).notes.length, 0)
  const now: Card = { post_by_friday: post === undefined ? 'n' : 'y', notes_ready: notes, ...got }
  const prior = db.prepare("SELECT body FROM desk_posts WHERE kind = 'scorecard' AND work_date = ?").get(shift(week, -7)) as { body: string } | undefined
  const was = prior === undefined ? null : JSON.parse(prior.body) as Card
  return { ...now, change: was === null ? null : {
    subscribers: now.subscribers - was.subscribers, open_rate: now.open_rate - was.open_rate, notes_ready: now.notes_ready - was.notes_ready,
    swaps: now.swaps === null || was.swaps === null ? null : now.swaps - was.swaps,
  } }
}

export function score(db: Db, root: string, plan: PlanRow, step: Step): Outcome {
  const title = titled(db, plan, 'scorecard')
  if (title === null) return { outcome: 'pass', spans: [], note: 'not a scorecard plan' }
  const week = shift(title.slice('scorecard '.length), -7)
  const dir = join(root, STATS)
  const day = (existsSync(dir) ? readdirSync(dir) : []).flatMap((f) => /^(\d{4}-\d{2}-\d{2})\.csv$/.exec(f)?.[1] ?? [])
    .filter((d) => d >= week && d <= shift(week, 6)).sort().at(-1)
  if (day === undefined) {
    const note = `no stats CSV for week ${week}`
    record(root, [{ at: new Date().toISOString(), plan: plan.id, ticket: ticketOf(db, plan.id), kind: 'late', step: step.step, name: step.name, note }])
    return { outcome: 'pass', spans: [], note }
  }
  const got = stats(root, day)
  if ('outcome' in got) return got
  const body = card(db, week, got)
  const { sources, swaps } = body
  const dek = [`post ${body.post_by_friday}`, `${String(body.notes_ready)} Notes`, `swaps ${swaps === null ? 'not recorded' : String(swaps)}`,
    `${String(body.subscribers)} subscribers`, `open rate ${String(body.open_rate)}`,
    `sources ${typeof sources === 'string' ? sources : String(Object.keys(sources).length)}`].join(' · ')
  db.prepare(`INSERT OR IGNORE INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date, proof_at)
    VALUES (?, 'scorecard', 'scorecard', 'proof', ?, ?, ?, '[]', '[]', ?, ?, datetime('now'))`)
    .run(plan.id, `scorecard/${week}`, dek, JSON.stringify(body), week, new Date().toISOString().slice(0, 10))
  return { outcome: 'pass', spans: [], note: `desk_posts ${String(plan.id)} scorecard/${week} in proof` }
}

const FIELDS = ['title', 'dek', 'body'] as const

function pattern(draft: number, edit: number): string {
  if (edit === 0) return 'cut'
  if (edit * 10 < draft * 9) return 'shortened'
  if (edit * 10 > draft * 11) return 'lengthened'
  return 'reworded'
}

export function capture(db: Db, root: string): Outcome {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(root, 'comms/voice-notes.md')
  const had = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null
  const lines = edited(db).flatMap((row) => FIELDS.flatMap((field) => {
    const edit = row[`edited_${field}`]
    if (edit === null) return []
    const note = row.note === null ? '' : ` — note: ${row.note.trim().replace(/\s*[\r\n]\s*/g, ' ')}`
    return [`- ${today} ${String(row.id)} ${field}: ${pattern(row[field].length, edit.length)} (${String(row[field].length)} → ${String(edit.length)} chars)${note}`]
  })).filter((line) => had?.includes(line) !== true)
  if (lines.length > 0) {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${had === null ? '# Voice notes\n\n' : ''}${lines.join('\n')}\n`)
  }
  return { outcome: 'pass', spans: [], note: `${String(lines.length)} voice note(s) added` }
}
