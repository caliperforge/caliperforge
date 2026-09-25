import { parse, stringify } from 'yaml'
import { z } from 'zod'
import type { Provider, Refusal } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { seat, tight } from '../runner/rules.ts'
import { wake } from '../runner/wake.ts'
import { decided, VERBS } from '../store/decisions.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { PlanRow } from '../store/plans.ts'
import { pending } from '../store/transcript.ts'
import { maybe, planDir, put } from './workspace.ts'

export const WAKE = ['token_ceiling', 'ready_proof', 'target_parked', 'no_step_map'] as const

const Waiting = PlanRow.extend({ wait_reason: z.enum(WAKE) })

type Waiting = z.infer<typeof Waiting>

const Answer = z.object({
  verb: z.enum(VERBS),
  why: z.string().trim().min(1).max(200),
  evidence: z.string().trim().min(1).optional(),
}).strict()

type Answer = z.infer<typeof Answer>

export async function woke(db: Db, root: string, provider: Provider, now: Date): Promise<void> {
  const rows = db.prepare(`SELECT * FROM plans WHERE wait_reason IN (${WAKE.map(() => '?').join(', ')})
    AND state IN ('queued', 'running', 'blocked_on_ceo') ORDER BY id`).all(...WAKE)
  for (const plan of rows.map((r) => Waiting.parse(r))) {
    const head = `step ${String(plan.step)} ${plan.wait_reason}`
    if (maybe(root, plan.id, 'orchestrator.md')?.split('\n')[0] === head) continue
    put(root, plan.id, 'orchestrator.md', `${head}\n\n${stringify(await decide(db, root, plan, provider, now))}`)
  }
}

async function decide(db: Db, root: string, plan: Waiting, provider: Provider, now: Date): Promise<Answer | Refusal> {
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
  decided(db, { plan: plan.id, step: plan.step, wait_reason: plan.wait_reason, verb: answer.verb, why: answer.why,
    evidence: answer.evidence ?? null, tokens: fired.usage.input + fired.usage.output })
  return answer
}

function read(text: string): Answer | Refusal {
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined) return refused('fence')
  let body: unknown
  try {
    body = parse(fence)
  } catch {
    return refused('fence')
  }
  const got = Answer.safeParse(body)
  if (got.success) return got.data
  const [issue] = got.error.issues
  return refused(String((issue?.code === 'unrecognized_keys' ? issue.keys[0] : issue?.path[0]) ?? 'fence'))
}

function refused(path: string): Refusal {
  return { origin_kind: 'ruling', origin_ref: 'orchestrator.decision', path }
}
