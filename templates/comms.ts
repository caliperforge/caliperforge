import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { landed, type Landed } from '../cli/batch.ts'
import { ours } from '../cli/gh.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { get, maybe, put } from '../sequencer/workspace.ts'
import { edited } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import { ofDay } from '../store/refusals.ts'
import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

const row = (name: string, step: number): Step =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null })

/** A merge signal opens one of these. P7 fills the write-up and its voice fixtures. */
export const steps: Step[] = ['gather', 'draft', 'facts', 'text_review', 'desk', 'publish', 'capture'].map((name, i) => row(name, i))

export function gather(db: Db, root: string, plan: PlanRow): Outcome {
  const packet = { landed: landed(db), refusals: ofDay(db, new Date().toISOString().slice(0, 10)) }
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

export function drafted(reply: string): (z.infer<typeof Fence> & { post: string }) | null {
  const fence = /(?:^|\n)---\n((?:\w+:.*\n)+)---\s*$/.exec(reply)
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
