import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Landed } from '../cli/batch.ts'
import { ours } from '../cli/gh.ts'
import { record, ticketOf } from '../cli/inbox.ts'
import type { Fired, Provider } from '../providers/kind.ts'
import { read } from '../reviews/verdict.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { ran } from '../sequencer/seat.ts'
import { get, maybe, put } from '../sequencer/workspace.ts'
import { edited } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { zone } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { ofDay } from '../store/refusals.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

const row = (name: string, step: number): Step =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null })

/** A merge signal opens one of these. P7 fills the write-up and its voice fixtures. */
export const steps: Step[] = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture', 'grow', 'pack', 'score'].map((name, i) =>
  name === 'grow' ? { ...row(name, i), seat: 'growth_lead', fires: 'seat', runs: 'growth_lead' }
  : name === 'draft' ? { ...row(name, i), seat: 'writer', fires: 'seat', runs: 'writer' }
  : name === 'text_review' ? { ...row(name, i), seat: 'text_review', fires: 'seat', runs: 'text_review' } : row(name, i))

export function gather(db: Db, root: string, plan: PlanRow): Outcome {
  const minutes = zone(db)
  const { title } = db.prepare('SELECT title FROM plans WHERE id = ?').get(plan.id) as { title: string | null }
  const day = /\d{4}-\d{2}-\d{2}$/.exec(title ?? '')?.[0] ?? new Date(Date.now() + minutes * 60000).toISOString().slice(0, 10)
  const shift = `${String(minutes)} minutes`
  const on = [shift, shift, day]
  const learned = db.prepare('SELECT items FROM desk_learnings WHERE date = ?').get(day) as { items: string } | undefined
  const packet = {
    day,
    learned: JSON.parse(learned?.items ?? '[]') as unknown[],
    drift: db.prepare(`SELECT number, title, datetime(opened_at, ?) AS at FROM tickets
      WHERE title GLOB 'Drift: *' AND date(opened_at, ?) = ? ORDER BY opened_at, number`).all(...on),
    decisions: db.prepare(`SELECT e.plan, p.title, e.actor, e.kind, e.message AS why, datetime(e.at, ?) AS at FROM events e
      LEFT JOIN plans p ON p.id = e.plan WHERE e.actor IN ('director', 'coo_lite') AND date(e.at, ?) = ? ORDER BY e.id`).all(...on),
    landed: db.prepare(`SELECT p.id AS plan, p.origin, a.subject_digest AS digest, p.title, datetime(a.approved_at, ?) AS at FROM plans p
      JOIN approvals a ON a.subject_kind = 'plan' AND a.subject_id = p.id AND a.who = 'gates'
      WHERE p.origin IS NOT NULL AND a.subject_digest = p.head_digest AND date(a.approved_at, ?) = ? ORDER BY p.id`).all(...on),
    refusals: ofDay(db, day, minutes),
  }
  put(root, plan.id, 'packet.json', JSON.stringify(packet))
  return { outcome: 'pass', spans: [], note: `${String(packet.landed.length)} landed, ${String(packet.refusals.length)} refused` }
}

export function facts(root: string, plan: PlanRow): Outcome {
  const draft = maybe(root, plan.id, 'draft.md')
  if (draft === null) return { outcome: 'pass', spans: [], note: 'no draft' }
  const packet = JSON.parse(get(root, plan.id, 'packet.json')) as { landed: Landed[]; refusals: { id: number }[] }
  const known = new Set([...packet.landed.map((l) => `[landed:${String(l.plan)}]`), ...packet.refusals.map((r) => `[refusal:${String(r.id)}]`)])
  const spans = draft.split('\n').flatMap((line, i) =>
    line.trim() === '' || sound(line, known) ? [] : [`draft.md:${String(i + 1)}`])
  if (spans.length === 0) return { outcome: 'pass', spans, note: 'every line cites the packet' }
  return { outcome: 'refuse', spans, note: `${String(spans.length)} draft line(s) cite no packet entry, or name an issue or an outside login` }
}

function sound(line: string, known: Set<string>): boolean {
  const tags = line.match(/\[(landed|refusal):\d+\]/g) ?? []
  return !/#\d|\/(issues|pull)\/\d/.test(line) && [...line.matchAll(/@([\w-]+)/g)].every((m) => ours(m[1]))
    && (tags.length > 0 || line.startsWith('#')) && tags.every((t) => known.has(t))
}

const REF = /^(https:\/\/\S+|[\w-][\w./-]*:[1-9]\d*)$/

const Fence = z.object({
  learnings: z.string().trim().min(1),
  dest: z.enum(['site', 'substack', 'note']),
  dek: z.string().trim().min(1).max(160).regex(/^[^`*_#[\]<>~]*$/),
  sources: z.array(z.object({ claim: z.string().trim().min(1), ref: z.string().regex(REF) })),
  checks: z.array(z.object({ label: z.string().trim().min(1), ok: z.boolean() })),
})

const CLOSING = /(?:^|\n)---\n((?:\w+:.*\n)+)---\s*$/

export function drafted(reply: string): (z.infer<typeof Fence> & { post: string }) | null {
  const fence = CLOSING.exec(reply)
  if (fence === null) return null
  const got = Fence.safeParse(prose(fence[1] ?? '', ['learnings', 'dek']))
  return got.success ? { ...got.data, post: reply.slice(0, fence.index).trim() } : null
}

const Stored = Fence.extend({ learnings: z.string().optional() })

export function desk(db: Db, root: string, plan: PlanRow): Outcome {
  const draft = maybe(root, plan.id, 'draft.md')
  if (draft === null) return { outcome: 'pass', spans: [], note: 'no draft' }
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

function titled(db: Db, plan: PlanRow, kind: string): string | null {
  const { title } = db.prepare('SELECT title FROM plans WHERE id = ?').get(plan.id) as { title: string | null }
  return title?.startsWith(`${kind} `) === true ? title : null
}

export async function grow(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if (titled(db, plan, 'growth') === null) return { outcome: 'pass', spans: [], note: 'not a growth plan' }
  const fired = await ran(db, root, plan, step, provider, `# packet.json\n\n${get(root, plan.id, 'packet.json')}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  put(root, plan.id, 'growth.md', fired.text)
  return { outcome: 'pass', spans: [], note: `${step.runs}: growth.md written` }
}

const halted = (step: Step, fired: Fired): Outcome => ({ outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${step.runs} ${fired.ended}` })

export async function draft(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  if ((titled(db, plan, 'daily') ?? titled(db, plan, 'ship')) === null) return { outcome: 'pass', spans: [], note: 'not a post plan' }
  const fired = await ran(db, root, plan, step, provider, `# packet.json\n\n${get(root, plan.id, 'packet.json')}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  const reply = drafted(fired.text)
  if (reply === null) return { outcome: 'refuse', spans: ['writer.fence'], note: `${step.runs} reply has no valid closing fence` }
  put(root, plan.id, 'draft.md', reply.post)
  put(root, plan.id, 'fence.json', JSON.stringify({ ...reply, post: undefined }))
  return { outcome: 'pass', spans: [], note: `${step.runs}: draft.md written` }
}

export async function review(db: Db, root: string, plan: PlanRow, step: Step, provider: Provider): Promise<Outcome> {
  const post = maybe(root, plan.id, 'draft.md')
  if (post === null) return { outcome: 'pass', spans: [], note: 'no draft' }
  const fired = await ran(db, root, plan, step, provider, `# draft.md\n\n${post}\n\n# packet.json\n\n${get(root, plan.id, 'packet.json')}`, false)
  if (fired.ended !== 'completed') return halted(step, fired)
  const judged = read(fired.text, post)
  if (judged === null) return { outcome: 'refuse', spans: ['text_review.fence'], note: `${step.runs} reply has no valid verdict fence` }
  if (judged.outcome === 'refuse') return { outcome: 'refuse', spans: judged.spans, note: judged.message, to: 1 }
  if (judged.outcome === 'needs_ceo') return { outcome: 'needs_ceo', spans: [], note: judged.message }
  put(root, plan.id, 'review.md', judged.message)
  return { outcome: 'pass', spans: [], note: `${step.runs}: review.md written` }
}

const Note = z.string().refine((note) => {
  const words = note.trim().split(/\s+/).length
  return words >= 31 && words <= 60 && !note.includes('?')
})

const Pack = z.object({
  topic: z.string().trim().min(1),
  notes: z.array(Note).length(14),
  replies: z.array(z.object({ to: z.string(), draft: z.string() })),
  partners: z.array(z.object({ name: z.string(), outreach: z.string() })),
})

export function pack(db: Db, root: string, plan: PlanRow): Outcome {
  const title = titled(db, plan, 'growth')
  if (title === null) return { outcome: 'pass', spans: [], note: 'not a growth plan' }
  const fence = CLOSING.exec(maybe(root, plan.id, 'growth.md') ?? '')
  const got = Pack.safeParse(fence === null ? null : prose(fence[1] ?? '', ['topic']))
  if (!got.success) return { outcome: 'refuse', spans: ['growth.md'], note: 'growth.md has no fence of a topic, 14 Notes of 31–60 words with no ?, replies and partners' }
  const { topic, notes, replies, partners } = got.data
  const work = /\d{4}-\d{2}-\d{2}$/.exec(title)?.[0] ?? plan.queued_at.slice(0, 10)
  db.prepare(`INSERT OR IGNORE INTO desk_posts (id, kind, dest, status, title, dek, body, sources, checks, work_date, written_date, proof_at)
    VALUES (?, 'growth', 'pack', 'proof', ?, '', ?, '[]', '[]', ?, ?, datetime('now'))`)
    .run(plan.id, topic, JSON.stringify({ notes, replies, partners }), work, new Date().toISOString().slice(0, 10))
  return { outcome: 'pass', spans: [], note: `desk_posts ${String(plan.id)} pack in proof for ${work}` }
}

export const SCORECARD_COLUMNS = { subscribers: 'Subscribers', open_rate: 'Open rate', sources: 'Source' }

const STATS = '.cf/growth/stats'

const shift = (day: string, days: number): string => new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10)

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
