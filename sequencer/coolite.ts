import { z } from 'zod'
import { record, ticketOf } from '../cli/inbox.ts'
import type { Post } from '../cli/watch.ts'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { logged } from '../store/events.ts'
import { retried } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { held, type PlanRow } from '../store/plans.ts'
import { pending } from '../store/transcript.ts'
import { split, type Part } from './brief.ts'
import { hold, unhold } from './hold.ts'
import { prose } from './prose.ts'
import { WIRE, type Wire } from './push.ts'
import { recorded } from './seat.ts'
import { parted } from './split.ts'
import { afresh, maybe, planDir, put, SELF } from './workspace.ts'

const Said = z.object({
  move: z.enum(['rule', 'waive', 'close', 'file', 'ask_ceo']),
  why: z.string().trim().min(1).max(400),
  answer: z.string().trim().min(1).optional(),
  ticket: z.string().trim().min(1).max(140).optional(),
}).strict().refine((m) => m.move !== 'rule' || m.answer !== undefined, { path: ['answer'] })
  .refine((m) => m.move !== 'file' || m.ticket !== undefined, { path: ['ticket'] })

type Move = z.infer<typeof Said> | { move: 'split'; why: string; parts: Part[] }

interface Told { outcome: 'pass' | 'needs_ceo'; message: string; note?: string }

function applying(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'coo_lite.apply'").get() as { value: string } | undefined
  return row?.value === '1'
}

export async function cooLite(db: Db, root: string, plan: PlanRow, provider: Provider, now: Date, post: Post,
  wire: Wire = WIRE): Promise<string> {
  if (plan.state !== 'blocked_on_ceo' && plan.state !== 'halted') {
    return told(db, root, plan, now, { outcome: 'needs_ceo', message: `ask_ceo: plan is ${plan.state}, not stopped` }, post)
  }
  const m = await ask(db, root, plan, provider)
  if (m === null) return told(db, root, plan, now, { outcome: 'needs_ceo', message: 'ask_ceo: no readable answer' }, post)
  const message = `${m.move}: ${m.why}`
  if (!applying(db)) return told(db, root, plan, now, { outcome: 'needs_ceo', message, note: `proposes ${message}` })
  if (m.move !== 'ask_ceo' && apply(db, root, plan, m, wire, now)) return told(db, root, plan, now, { outcome: 'pass', message })
  hold(db, root, plan.id, m.why, now)
  held(db, plan.id, 'ceo', m.why)
  return told(db, root, plan, now, { outcome: 'needs_ceo', message }, post)
}

async function ask(db: Db, root: string, plan: PlanRow, provider: Provider): Promise<Move | null> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, 'coo_lite')
  const dir = planDir(root, plan.id)
  const fired = await provider.fire({
    ...packet(manifest, prompt, tight(root), text(root, plan), dir, pending(dir, 'coo_lite')),
    wall: wall(db),
  })
  recorded(db, plan.id, plan.step, 'coo_lite', hash, provider.name, manifest, fired)
  return fired.ended === 'completed' ? read(fired.text) : null
}

function text(root: string, plan: PlanRow): string {
  const at = (name: string): string => maybe(root, plan.id, name) ?? 'none'
  return [
    `# Job\n\nplan ${String(plan.id)}, state ${plan.state}, step ${String(plan.step)}, lane ${plan.lane ?? '-'}, ${plan.origin ?? 'no ticket'}`,
    `# Stop\n\n${maybe(root, plan.id, 'refusal.md') ?? at('question.md')}`,
    `# Orchestrator\n\n${at('orchestrator.md')}`,
    `# Ask\n\n${at('ask.md')}`,
  ].join('\n\n')
}

function read(text: string): Move | null {
  const parts = split(text)
  if (parts !== null) return { move: 'split', why: `${String(parts.length)} jobs, not one`, parts }
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined) return null
  const got = Said.safeParse(prose(fence, ['why', 'answer', 'ticket']))
  return got.success ? got.data : null
}

/** Each move is the call its `cf` command makes; false leaves the stop with a person. */
function apply(db: Db, root: string, plan: PlanRow, m: Move, wire: Wire, now: Date): boolean {
  switch (m.move) {
    case 'rule':
      put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}\n## Answer from the COO\n\n${m.answer ?? ''}\n`)
      unhold(db, root, plan.id, 'coo_lite')
      return true
    case 'waive':
      if (plan.state !== 'blocked_on_ceo') return false
      afresh(root, plan.id, retried(db, plan.id, 'coo_lite'))
      return true
    case 'split':
      if (parted(db, root, plan, m.parts, wire).split !== true) return false
      db.prepare("UPDATE plans SET state = 'done' WHERE id = ?").run(plan.id)
      return true
    case 'close':
      if (db.prepare("SELECT 1 FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(plan.id) === undefined) return false
      db.prepare("UPDATE plans SET state = 'done', wait_reason = NULL WHERE id = ?").run(plan.id)
      return true
    case 'file': {
      const url = wire.file(SELF, m.ticket ?? m.why, `Filed by coo_lite on plan ${String(plan.id)}.\n\n${m.why}`,
        ['lane:machine', 'P0', 'fix'])
      hold(db, root, plan.id, `${url}\n\n${m.why}`, now)
      return true
    }
    case 'ask_ceo': return false
  }
}

function told(db: Db, root: string, plan: PlanRow, now: Date, t: Told, post?: Post): string {
  logged(db, { plan: plan.id, kind: 'coo_lite', actor: 'coo_lite', outcome: t.outcome, message: t.message, pointer: null, run: null })
  const ticket = ticketOf(db, plan.id)
  const kind = t.outcome === 'pass' ? 'refused' : 'blocked'
  record(root, [{ at: now.toISOString(), plan: plan.id, ticket, kind, step: plan.step, name: 'coo_lite', note: t.note ?? t.message }])
  post?.(`CaliperForge · ${ticket} needs you`, `plan ${String(plan.id)}, step ${String(plan.step)}. coo_lite: ${t.message}`)
  return t.message
}
