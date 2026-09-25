import { createHash } from 'node:crypto'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type { Provider, Refusal } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { seat, tight } from '../runner/rules.ts'
import { wake } from '../runner/wake.ts'
import { ticketOf } from '../cli/inbox.ts'
import { alerter, type Post } from '../cli/watch.ts'
import { decided, VERBS, type Verb } from '../store/decisions.ts'
import { clear as unlease, take } from '../store/leases.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { PlanRow } from '../store/plans.ts'
import { pending } from '../store/transcript.ts'
import { act, applying } from './act.ts'
import { fixer } from './fixer.ts'
import { WIRE, type Wire } from './push.ts'
import { maybe, planDir, put } from './workspace.ts'

export const WAKE = ['token_ceiling', 'ready_proof', 'target_parked', 'no_step_map'] as const

type Woken = (typeof WAKE)[number] | 'blocked_on_ceo'

const Answer = z.object({
  verb: z.enum(VERBS),
  why: z.string().trim().min(1).max(200),
  evidence: z.string().trim().min(1).optional(),
}).strict()

type Answer = z.infer<typeof Answer>

/** #238: once `orchestrator.apply` is on, a decision is acted on as soon as it is made. The lease keeps two overlapping ticks off one stop. */
export async function woke(db: Db, root: string, provider: Provider, now: Date, post: Post = alerter(), wire: Wire = WIRE): Promise<void> {
  const rows = db.prepare(`SELECT * FROM plans WHERE (wait_reason IN (${WAKE.map(() => '?').join(', ')})
    AND state IN ('queued', 'running', 'blocked_on_ceo')) OR state = 'blocked_on_ceo' ORDER BY id`).all(...WAKE)
  for (const plan of rows.map((r) => PlanRow.parse(r))) {
    const reason = woken(plan)
    const head = `step ${String(plan.step)} ${reason === 'blocked_on_ceo' ? `blocked ${stop(root, plan.id)}` : reason}`
    if (maybe(root, plan.id, 'orchestrator.md')?.split('\n')[0] === head) continue
    if (take(db, plan.id, now) === null) continue
    try {
      const got = await decide(db, root, plan, reason, provider, now)
      put(root, plan.id, 'orchestrator.md', `${head}\n\n${stringify('id' in got ? got.answer : got)}`)
      if ('id' in got && applying(db)) await handle(db, root, plan, { id: got.id, ...got.answer }, provider, now, post, wire)
    } finally {
      unlease(db, plan.id)
    }
  }
}

/** An `ask_coo` goes to the fixer first; what it does not take is acted on or escalated as before. */
async function handle(db: Db, root: string, plan: PlanRow, d: { id: number; verb: Verb; why: string }, provider: Provider,
  now: Date, post: Post, wire: Wire): Promise<void> {
  const ticket = ticketOf(db, plan.id)
  const fixed = d.verb === 'ask_coo' && await fixer(db, root, plan, d, ticket, provider, now, post, wire)
  if (!fixed) act(db, root, plan, d, ticket, now, post)
}

function woken(plan: PlanRow): Woken {
  return (WAKE as readonly string[]).includes(plan.wait_reason ?? '') ? plan.wait_reason as Woken : 'blocked_on_ceo'
}

/** #246: one stop is one refusal (or question) as written; the same words at the same step are the same stop. */
function stop(root: string, plan: number): string {
  const said = maybe(root, plan, 'refusal.md') ?? maybe(root, plan, 'question.md')
  return said === null ? 'none' : createHash('sha256').update(said).digest('hex').slice(0, 12)
}

async function decide(db: Db, root: string, plan: PlanRow, reason: Woken, provider: Provider, now: Date):
  Promise<{ id: number; answer: Answer & { verb: Verb } } | Refusal> {
  const woken = wake(db, root, plan.id, now)
  if ('refusal' in woken) return woken.refusal
  const { manifest, prompt } = seat(root, 'orchestrator')
  const dir = planDir(root, plan.id)
  const fired = await provider.fire({
    ...packet(manifest, prompt, tight(root), woken.text, dir, pending(dir, 'orchestrator')),
    wall: wall(db),
  })
  const answer = fired.exit === 0 ? read(fired.text) : refused('exit')
  if ('origin_kind' in answer) return answer
  const id = decided(db, { plan: plan.id, step: plan.step, wait_reason: reason, verb: answer.verb, why: answer.why,
    evidence: answer.evidence ?? null, tokens: fired.usage.input + fired.usage.output })
  return { id, answer }
}

function read(text: string): Answer | Refusal {
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined) return refused('fence')
  const body = yaml(fence) ?? lines(fence)
  if (body === null) return refused('fence')
  const got = Answer.safeParse(body)
  if (got.success) return got.data
  const [issue] = got.error.issues
  return refused(String((issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0]) ?? 'fence'))
}

function yaml(fence: string): unknown {
  try {
    return parse(fence) as unknown
  } catch {
    return null
  }
}

/** A `why` with a colon in it is prose, not YAML: each line is its key up to the first colon and the rest as written. */
function lines(fence: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of fence.split('\n').filter((l) => l.trim() !== '')) {
    const got = /^(\w+):\s*(.*)$/.exec(line)
    if (got === null) return null
    out[got[1] ?? ''] = (got[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

function refused(path: string): Refusal {
  return { origin_kind: 'ruling', origin_ref: 'orchestrator.decision', path }
}
