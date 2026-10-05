import { z } from 'zod'
import { record, ticketOf } from '../cli/inbox.ts'
import { alerter, type Post } from '../cli/watch.ts'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { decision } from '../store/ask.ts'
import { decisions } from '../store/decisions.ts'
import { logged } from '../store/events.ts'
import { retried, returnToLane } from '../store/holds.ts'
import type { Db } from '../store/index.ts'
import { wall } from '../store/lanes.ts'
import { clear as unlease, take } from '../store/leases.ts'
import { busy, current, idle } from '../store/now.ts'
import { end, held, needsCeo, originRef, planById, PlanRow, retry } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { pending } from '../store/transcript.ts'
import { split, type Part } from './brief.ts'
import { isHeld, unhold } from './hold.ts'
import { fixed, stop } from './fixed.ts'
import { released } from './fixer.ts'
import { prose } from './prose.ts'
import { builderWork, outOfReach, WAITING } from './reach.ts'
import { WIRE, type Wire } from './push.ts'
import { rule } from './rule.ts'
import { recorded } from './seat.ts'
import { parted } from './split.ts'
import { ticketed } from './ticket.ts'
import { history, parentAsk } from './record.ts'
import { READ, SERVER, server } from './upstream.ts'
import { afresh, maybe, planDir, put } from './workspace.ts'

const Said = z.object({
  move: z.enum(['rule', 'waive', 'close', 'file', 'ask_ceo', 'ask_coo', 'return', 'fix']),
  why: z.string().trim().min(1),
  answer: z.string().trim().min(1).optional(),
  ticket: z.string().trim().min(1).transform((t) => t.slice(0, 140)).optional(),
  class: z.coerce.number().int().min(1).max(4).optional(),
}).strict().refine((m) => m.move !== 'rule' || m.answer !== undefined, { path: ['answer'] })
  .refine((m) => m.move !== 'file' || m.ticket !== undefined, { path: ['ticket'] })
  .refine((m) => m.move !== 'ask_ceo' || m.class !== undefined, { path: ['class'] })

type Move = z.infer<typeof Said> | { move: 'split'; why: string; parts: Part[] }

interface Told { outcome: 'pass' | 'needs_ceo'; message: string; note?: string; pointer?: string | null }

function applying(db: Db): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'director.apply'").get() as { value: string } | undefined
  return row?.value === '1'
}

export async function cooLite(db: Db, root: string, plan: PlanRow, provider: Provider, now: Date, post: Post,
  wire: Wire = WIRE, tried?: string): Promise<string> {
  if (plan.state !== 'blocked_on_ceo' && plan.state !== 'halted') {
    return WAITING.has(plan.wait_reason ?? '') ? told(db, root, plan, now, { outcome: 'pass', message: `left alone: plan is ${plan.state}, waiting on ${plan.wait_reason ?? ''}` })
      : told(db, root, plan, now, { outcome: 'needs_ceo', message: `ask_ceo: plan is ${plan.state}, not stopped` }, post)
  }
  let { m, said } = await ask(db, root, plan, provider, tried)
  const n = failures(db, root, plan)
  const first = refused(m, said, n, root)
  if (first !== null) {
    ({ m, said } = await ask(db, root, plan, provider, tried, first.fence))
    const again = refused(m, said, n, root)
    if (again !== null) return m?.move === 'fix' && builderWork(root, m.why) && applying(db) && apply(db, root, plan, { move: 'rule', why: m.why, answer: m.why }, wire, now) === true
      ? told(db, root, plan, now, { outcome: 'pass', message: `rule: ${m.why} (out of the fixer's reach, so the builder takes it)` })
      : told(db, root, plan, now, { outcome: 'needs_ceo', message: again.message }, post)
  }
  if (m === null) return told(db, root, plan, now, { outcome: 'needs_ceo', message: 'ask_ceo: no readable answer' }, post)
  const message = `${m.move}: ${m.why}`
  if (!applying(db)) return told(db, root, plan, now, { outcome: 'needs_ceo', message, note: `proposes ${message}` })
  const done = m.move === 'fix' ? await fixed(db, root, plan, m.why, provider, now, post, wire)
    : m.move !== 'ask_ceo' && m.move !== 'ask_coo' && apply(db, root, plan, m, wire, now)
  if (done !== false) return told(db, root, plan, now, { outcome: 'pass', message, pointer: done === true ? null : done })
  if (m.move === 'fix' && tried === undefined) return cooLite(db, root, planById(db, plan.id), provider, now, post, wire, m.why)
  if (m.move === 'ask_ceo' || m.move === 'ask_coo') {
    held(db, plan.id, m.move === 'ask_ceo' ? 'ceo' : 'coo', m.why)
    const ceo = decision(said)
    return told(db, root, plan, now, { outcome: 'needs_ceo', message: m.move === 'ask_ceo' && 'block' in ceo ? `${message}\n\n${ceo.block}` : message }, post)
  }
  const failed = `${m.move} did not apply, ${UNAPPLIED[m.move]}: ${m.why}`
  needsCeo(db, plan, failed)
  held(db, plan.id, 'coo', failed)
  return told(db, root, plan, now, { outcome: 'needs_ceo', message: failed }, post)
}

function refused(m: Move | null, said: string, n: number, root: string): { fence: string; message: string } | null {
  if (m?.move === 'fix') return outOfReach(root, m.why)
  if (m?.move === 'ask_coo' && n < 2) {
    return { fence: `ask_coo is refused: ${String(n)} failed fixes on this stop, two are needed. Choose another move.`,
      message: `ask_coo: refused by the fence, ${String(n)} failed fixes on this stop` }
  }
  const ceo = m?.move === 'ask_ceo' ? decision(said) : null
  if (ceo === null || !('refused' in ceo)) return null
  return { fence: `ask_ceo is refused: ${ceo.refused}. Write the decision block, or choose another move.`,
    message: `ask_ceo: refused by the fence, ${ceo.refused}` }
}

interface Stop { id: number; answered: number | null; today: number }

export async function byHand(db: Db, root: string, provider: Provider, now: Date, post: Post = alerter(),
  wire: Wire = WIRE): Promise<string> {
  return fire(db, root, provider, now, post, wire, stops(db, root, now, post))
}

function stops(db: Db, root: string, now: Date, post: Post): Stop[] {
  const rows = db.prepare(`SELECT p.id, e.ruled >= d.at AS answered,
      (SELECT count(*) FROM events WHERE plan = p.id AND kind IN ('director', 'coo_lite') AND outcome = 'pass'
        AND at >= datetime(@at, '-1 day')) AS today
    FROM plans p JOIN decisions d ON d.id = (SELECT max(id) FROM decisions WHERE plan = p.id)
    LEFT JOIN (SELECT plan, max(at) AS ruled FROM events WHERE kind IN ('director', 'coo_lite') GROUP BY plan) e ON e.plan = p.id
    WHERE p.state = 'blocked_on_ceo' AND p.held_by = 'coo' AND d.verb IN ('ask_coo', 'ask_ceo')
    ORDER BY d.at, p.id`).all({ at: now.toISOString() }) as Stop[]
  const fresh: Stop[] = []
  for (const s of rows.filter((s) => s.answered !== 1 && !isHeld(root, s.id))) {
    if (s.today >= 2) told(db, root, planById(db, s.id), now, { outcome: 'needs_ceo', message: 'ask_coo: director answered this plan twice today' }, post)
    else fresh.push(s)
  }
  return fresh
}

async function fire(db: Db, root: string, provider: Provider, now: Date, post: Post, wire: Wire,
  fresh: Stop[]): Promise<string> {
  const [oldest] = fresh
  if (oldest === undefined) return 'no stopped plan'
  if (current(db).some((n) => n.doing === 'director' && !n.stale)) return 'a director run is live'
  const ran = db.prepare("SELECT count(*) AS n FROM runs WHERE seat = 'director' AND at >= datetime(?, '-1 day')")
    .get(now.toISOString()) as { n: number }
  const cap = db.prepare("SELECT value FROM settings WHERE key = 'coo_lite.max_daily'").get() as { value: string } | undefined
  if (ran.n >= Number(cap?.value ?? 12)) return `cap reached: ${String(ran.n)} director runs today`
  if (take(db, oldest.id, now) === null) return `plan ${String(oldest.id)} is leased`
  try {
    busy(db, oldest.id, 'director', `${String(fresh.length)} stops waiting`, now)
    return await cooLite(db, root, planById(db, oldest.id), provider, now, post, wire)
  } finally {
    idle(db, oldest.id)
    unlease(db, oldest.id)
  }
}

function failures(db: Db, root: string, plan: PlanRow): number {
  const at = stop(root, plan.id)
  return decisions(db, plan.id).filter((d) => d.verb === 'ask_coo' && d.evidence === at).length
}

async function ask(db: Db, root: string, plan: PlanRow, provider: Provider, tried?: string,
  fence?: string): Promise<{ m: Move | null; said: string }> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, 'director')
  const dir = planDir(root, plan.id)
  const built = packet(manifest, prompt, tight(root), text(db, root, plan, tried, fence), dir, pending(dir, 'director'))
  const fired = await provider.fire({
    ...built,
    tools: [...built.tools, READ],
    servers: { [SERVER]: server(db, plan.id, 'director') },
    wall: wall(db),
  })
  recorded(db, plan.id, plan.step, 'director', hash, provider.name, manifest, fired)
  return fired.ended === 'completed' ? { m: read(fired.text), said: fired.text } : { m: null, said: '' }
}

function text(db: Db, root: string, plan: PlanRow, tried?: string, fence?: string): string {
  const at = (name: string): string => maybe(root, plan.id, name) ?? 'none'
  return [
    `# Job\n\nplan ${String(plan.id)}, state ${plan.state}, step ${String(plan.step)}, lane ${plan.lane ?? '-'}, ${plan.origin ?? 'no ticket'}`,
    `# Stop\n\n${maybe(root, plan.id, 'refusal.md') ?? at('question.md')}`,
    `# Orchestrator\n\n${at('orchestrator.md')}`,
    `# Ask\n\n${at('ask.md')}`,
    `# Parent ticket\n\n${parentAsk(db, root, plan)}`,
    `# Record\n\n${history(db, plan)}`,
    `# Rulings on this plan\n\n${own(root, plan)}`,
    `# Rulings on sibling plans\n\n${siblings(db, root, plan)}`,
    ...(tried === undefined ? [] : [`# Fixer\n\nthe fixer did not make this fix: ${tried}`]),
    ...(fence === undefined ? [] : [`# Fence\n\n${fence}`]),
  ].join('\n\n')
}

function sections(text: string | null): string[] {
  return (text ?? '').split(/^(?=## )/m).filter((s) => /^## (?:Ruling|Answer)/.test(s)).map((s) => s.trim())
}

function own(root: string, plan: PlanRow): string {
  const rulings = maybe(root, plan.id, 'rulings.md')?.trim() ?? ''
  const found = [...(rulings === '' ? [] : [`rulings.md:\n${rulings}`]),
    ...sections(maybe(root, plan.id, 'issue.md')).map((s) => `issue.md:\n${s}`)]
  return found.length === 0 ? 'none' : found.join('\n\n').slice(0, 6000)
}

function siblings(db: Db, root: string, plan: PlanRow): string {
  const ref = originRef(plan)
  if (ref === null) return 'none'
  const ids = db.prepare(`SELECT p.id FROM plans p
    JOIN tickets t ON p.origin = 'https://github.com/' || t.repo || '/issues/' || t.number
    WHERE t.repo = ? AND t.parent = (SELECT parent FROM tickets WHERE repo = ? AND number = ?) AND p.id <> ?
    ORDER BY p.id`).all(ref.repo, ref.repo, ref.no, plan.id) as { id: number }[]
  const found = ids.flatMap(({ id }) => ['ask.md', 'issue.md'].flatMap((name) =>
    sections(maybe(root, id, name)).map((s) => `plan ${String(id)}, ${name}:\n${s}`)))
  return found.length === 0 ? 'none' : found.join('\n\n').slice(0, 6000)
}

/** `why` has no length cap: a long one is still an answer. */
export function read(text: string): Move | null {
  const parts = split(text)
  if (parts !== null) return { move: 'split', why: `${String(parts.length)} jobs, not one`, parts }
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined) return null
  const got = Said.safeParse(prose(fence, ['why', 'answer', 'ticket']))
  if (got.success) return got.data
  const lined = Said.safeParse(Object.fromEntries([...fence.matchAll(/^(move|why|answer|ticket|class):[ \t]*(.+)$/gm)]
    .map((m) => [m[1], (m[2] ?? '').trim()])))
  return lined.success ? lined.data : null
}

const UNAPPLIED: Record<Exclude<Move['move'], 'ask_ceo' | 'ask_coo'>, string> = {
  rule: 'the answer names a path a ruling may not carry',
  waive: 'the plan is not blocked_on_ceo',
  split: 'the parts were not filed',
  close: 'no deliverable is pushed',
  file: 'the ticket was not filed',
  return: 'the plan did not go back to its lane',
  fix: 'the fixer did not make the fix',
}

/** Each move is the call its `cf` command makes; false leaves the stop with a person. */
function apply(db: Db, root: string, plan: PlanRow, m: Move, wire: Wire, now: Date): boolean | string {
  switch (m.move) {
    case 'rule': {
      const to = rule(db, root, plan, 'director', m.answer ?? '')
      if (to === null) return false
      if (to === 'ask.md') unhold(db, root, plan.id, 'director')
      else afresh(root, plan.id, db.transaction(() => { clear(db, plan.id); return retry(db, plan) })())
      const ref = originRef(plan)
      if (ref !== null) wire.comment(ref.repo, ref.no, `Ruled by director on plan ${String(plan.id)}.\n\n${m.answer ?? ''}`)
      return true
    }
    case 'waive':
      if (plan.state !== 'blocked_on_ceo') return false
      afresh(root, plan.id, retried(db, plan.id, 'director'))
      return true
    case 'split':
      if (parted(db, root, plan, m.parts, wire).split !== true) return false
      end(db, plan.id, 'done')
      return true
    case 'close':
      if (db.prepare("SELECT 1 FROM deliverables WHERE plan_id = ? AND state = 'pushed'").get(plan.id) === undefined) return false
      end(db, plan.id, 'done')
      return true
    case 'file':
      return ticketed(db, root, plan, m.ticket ?? m.why, `Filed by director on plan ${String(plan.id)}.\n\n${m.why}`, m.why, wire, now)
    case 'return':
      afresh(root, plan.id, returnToLane(db, plan.id, 'director'))
      return true
    case 'fix':
    case 'ask_ceo':
    case 'ask_coo': return false
  }
}

function told(db: Db, root: string, plan: PlanRow, now: Date, t: Told, post?: Post): string {
  logged(db, { plan: plan.id, kind: 'director', actor: 'director', outcome: t.outcome, message: t.message, pointer: t.pointer ?? null, run: null })
  const ticket = ticketOf(db, plan.id)
  const kind = t.outcome === 'pass' ? 'refused' : 'blocked'
  record(root, [{ at: now.toISOString(), plan: plan.id, ticket, kind, step: plan.step, name: 'director', note: t.note ?? t.message }])
  post?.(`CaliperForge · ${ticket} needs you`, `plan ${String(plan.id)}, step ${String(plan.step)}. director: ${t.message}`)
  return t.message
}

export const WAKE = ['token_ceiling', 'ready_proof', 'target_parked', 'no_step_map'] as const

type Woken = (typeof WAKE)[number] | 'blocked_on_ceo'

/** The lease keeps two overlapping ticks off one stop. */
export async function woke(db: Db, root: string, provider: Provider, now: Date, post: Post = alerter(), wire: Wire = WIRE): Promise<void> {
  released(db, root, now, post)
  const rows = db.prepare(`SELECT * FROM plans WHERE ((wait_reason IN (${WAKE.map(() => '?').join(', ')})
    AND state IN ('queued', 'running', 'blocked_on_ceo')) OR state = 'blocked_on_ceo') AND held_by IS NOT 'ceo' ORDER BY id`).all(...WAKE)
  for (const plan of rows.map((r) => PlanRow.parse(r))) {
    const reason = woken(plan)
    const head = `step ${String(plan.step)} ${reason === 'blocked_on_ceo' ? `blocked ${stop(root, plan.id)}` : reason}`
    if (isHeld(root, plan.id)) continue
    if (maybe(root, plan.id, 'orchestrator.md')?.split('\n')[0] === head) continue
    if (take(db, plan.id, now) === null) continue
    try {
      put(root, plan.id, 'orchestrator.md', `${head}\n\n${await cooLite(db, root, plan, provider, now, post, wire)}\n`)
    } finally {
      unlease(db, plan.id)
    }
  }
}

function woken(plan: PlanRow): Woken {
  return (WAKE as readonly string[]).includes(plan.wait_reason ?? '') ? plan.wait_reason as Woken : 'blocked_on_ceo'
}
