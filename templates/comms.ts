import { z } from 'zod'
import { landed, type Landed } from '../cli/batch.ts'
import { ours } from '../cli/gh.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { prose } from '../sequencer/prose.ts'
import { get, maybe, put } from '../sequencer/workspace.ts'
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
