import { join } from 'node:path'
import { z } from 'zod'
import type { Fired, Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import type { Db } from '../store/index.ts'
import { get, wall } from '../store/lanes.ts'
import { pending } from '../store/transcript.ts'
import { prose } from './prose.ts'
import { maybe } from './workspace.ts'

const TEXT_CHARS = 8_000
const RULINGS_CHARS = 24_000

const Entry = z.object({
  plan: z.coerce.number().int(),
  move: z.enum(['return', 'retry', 'ask_ceo', 'ticket']),
  ruling: z.string().trim().min(1).max(1200),
  ceo_question: z.string().trim().min(1).optional(),
}).strict().refine((e) => (e.move === 'ask_ceo') === (e.ceo_question !== undefined), { path: ['ceo_question'] })

export type Entry = z.infer<typeof Entry>

const Reply = z.object({ rulings: z.array(Entry) }).strict()

interface Held { id: number; state: string; step: number; lane: string | null; origin: string | null }

export async function coo(db: Db, root: string, provider: Provider): Promise<{ fired: Fired; entries: Entry[] | null } | null> {
  const held = db.prepare(`SELECT p.id, p.state, p.step, p.lane, p.origin FROM plans p
    JOIN decisions d ON d.id = (SELECT max(id) FROM decisions WHERE plan = p.id)
    WHERE p.state = 'blocked_on_ceo' AND d.applied IN ('escalated', 'capped') ORDER BY p.id`).all() as Held[]
  if (held.length === 0) return null
  load(db, root)
  const { manifest, prompt } = seat(root, 'light_coo')
  const text = [...held.map((p) => section(db, root, p)), `# Rulings table\n\n${cut(table(db), RULINGS_CHARS)}`].join('\n\n')
  const site = get(db, 'comms.site_dir')
  const fired = await provider.fire({
    ...packet(manifest, prompt, tight(root), text, root, pending(join(root, '.cf/work'), 'light_coo')),
    wall: wall(db),
    reads: site === '' ? [] : [site],
  })
  return { fired, entries: fired.ended === 'completed' ? read(fired.text, held.map((p) => p.id)) : null }
}

function section(db: Db, root: string, p: Held): string {
  const at = (name: string): string => maybe(root, p.id, name) ?? 'none'
  const fixes = (maybe(root, p.id, 'fixes.jsonl') ?? '').split('\n').filter((l) => l.trim() !== '').slice(-2).join('\n')
  const siblings = (db.prepare(`SELECT s.plan FROM parts me JOIN parts s ON s.parent = me.parent
    WHERE me.plan = ? AND s.plan IS NOT NULL AND s.plan <> me.plan ORDER BY s.plan`).all(p.id) as { plan: number }[])
    .flatMap((s) => blocks(maybe(root, s.plan, 'ask.md') ?? '').map((b) => `plan ${String(s.plan)}:\n\n${b}`))
  return [
    `# Plan ${String(p.id)}\n\nstate ${p.state}, step ${String(p.step)}, lane ${p.lane ?? '-'}, ${p.origin ?? 'no ticket'}`,
    `## Stop\n\n${cut(maybe(root, p.id, 'refusal.md') ?? at('question.md'), TEXT_CHARS)}`,
    `## Ask\n\n${cut(at('ask.md'), TEXT_CHARS)}`,
    `## Fixes\n\n${cut(fixes || 'none', TEXT_CHARS)}`,
    `## Orchestrator\n\n${cut(at('orchestrator.md'), TEXT_CHARS)}`,
    `## Sibling rulings\n\n${cut(siblings.join('\n\n') || 'none', TEXT_CHARS)}`,
  ].join('\n\n')
}

function blocks(ask: string): string[] {
  return [...ask.matchAll(/^## Ruling[\s\S]*?(?=^## |(?![\s\S]))/gm)].map((m) => m[0].trim())
}

function table(db: Db): string {
  return (db.prepare(`SELECT subject, value, who, date, issue_no FROM rulings r
    WHERE NOT EXISTS (SELECT 1 FROM rulings s WHERE s.supersedes = r.id) ORDER BY r.id`).all() as
    { subject: string; value: string; who: string; date: string; issue_no: number }[])
    .map((r) => `${r.subject}: ${r.value} (${r.who} ${r.date}, #${String(r.issue_no)})`).join('\n')
}

function read(text: string, ids: number[]): Entry[] | null {
  const fence = [...text.matchAll(/^---\n([\s\S]*?)\n---$/gm)].at(-1)?.[1]
  if (fence === undefined) return null
  const got = Reply.safeParse(prose(fence, ['ruling', 'ceo_question']))
  return got.success ? got.data.rulings.filter((e) => ids.includes(e.plan)) : null
}

function cut(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}\n\n[cut at ${String(n)} characters]`
}
