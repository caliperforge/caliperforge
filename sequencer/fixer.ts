import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { record, ticketOf } from '../cli/inbox.ts'
import type { Post } from '../cli/watch.ts'
import type { Provider } from '../providers/kind.ts'
import { packet } from '../runner/index.ts'
import { load, seat, tight } from '../runner/rules.ts'
import { mark } from '../store/decisions.ts'
import { pushed } from '../store/deliverables.ts'
import { setting } from '../store/drift.ts'
import { logged as event } from '../store/events.ts'
import { listed, recorded as paths } from '../store/files.ts'
import { schema, type Db } from '../store/index.ts'
import { returnToLane } from '../store/holds.ts'
import { wall } from '../store/lanes.ts'
import { clearWaitsOn, end, held, requeue, retry, type PlanRow } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { openJobs, waitable, waitsEnded } from '../store/stops.ts'
import { pending } from '../store/transcript.ts'
import { lapsed } from '../store/until.ts'
import { coder, repaired } from './coder.ts'
import { hold, unhold } from './hold.ts'
import { prose } from './prose.ts'
import { WIRE, type Wire } from './push.ts'
import { rule } from './rule.ts'
import { recorded } from './seat.ts'
import { landed } from './landed.ts'
import { stuck } from './stuck.ts'
import { ticketed } from './ticket.ts'
import { afresh, cloned, drop, maybe, move, planDir, put, titleOf } from './workspace.ts'

/**
 * The orchestrator's hands. An `ask_coo` decision goes to the fixer, which makes the hand fix
 * in that one job's folder and says where the job goes next. `fixer.mode` is off, shadow (reads only, changes
 * nothing, the decision still escalates) or live.
 */
export type Mode = 'off' | 'shadow' | 'live'

export const THEN = ['return', 'retry', 'done', 'park', 'wait', 'rebuild', 'ticket', 'ask_ceo'] as const

/** Past this many fixes on one job in a day it is not a hand fix any more, and the next stop goes to a person. */
export const FIXES = 2

/** One fix may spend this much; the job's own run wall is higher and is for building, not repairing. */
const FIX_WALL = 400_000

const STORE_CHARS = 24_000
const TEXT_CHARS = 8_000

const Fix = z.object({
  did: z.string().trim().min(1).max(600),
  then: z.enum(THEN),
  why: z.string().trim().min(1).max(400),
  ticket: z.string().trim().min(1).max(140).optional(),
  add_files: z.array(z.string().trim().min(1)).optional(),
  waits_on: z.coerce.number().int().positive().optional(),
  until: z.string().trim().min(1).refine((t) => !Number.isNaN(Date.parse(t))).optional(),
  answer: z.string().trim().min(1).max(1200).optional(),
}).strict().refine((f) => f.then !== 'ticket' || f.ticket !== undefined, { path: ['ticket'] })
  .refine((f) => f.then !== 'wait' || f.waits_on !== undefined, { path: ['waits_on'] })
  .refine((f) => f.then !== 'park' || f.until !== undefined, { path: ['until'] })

export type Fix = z.infer<typeof Fix>

interface Logged { at: string; mode: Mode; did: string; then: string; why: string; tokens: number; applied: string }

export function mode(db: Db): Mode {
  const value = setting(db, 'fixer.mode')
  return value === 'live' || value === 'shadow' ? value : 'off'
}

function fixesToday(root: string, plan: number, now: Date): number {
  const since = now.getTime() - 24 * 60 * 60 * 1000
  return logged(root, plan).filter((l) => l.mode === 'live' && Date.parse(l.at) >= since).length
}

/**
 * Returns true when the fixer took the stop (live, and it did not hand it to a person), so the orchestrator's
 * own escalation is skipped. Shadow always returns false: the person still hears about it.
 */
export async function fixer(db: Db, root: string, plan: PlanRow, decision: { id: number; why: string }, ticket: string,
  provider: Provider, now: Date, post: Post, wire: Wire = WIRE): Promise<boolean> {
  const m = mode(db)
  if (m === 'off') return false
  if (m === 'live' && fixesToday(root, plan.id, now) >= FIXES) return false
  const to = gone(root, plan) ? null : coder(db, root, plan)
  const { got, tokens } = gone(root, plan) ? { got: GONE, tokens: 0 } : await ask(db, root, plan, decision, m, to, provider)
  if (got === null) {
    log(root, plan.id, { at: now.toISOString(), mode: m, did: 'nothing', then: 'ask_ceo', why: 'no readable answer', tokens, applied: 'unreadable' })
    return false
  }
  if (m === 'shadow') {
    log(root, plan.id, { at: now.toISOString(), mode: m, ...got, tokens, applied: 'shadow' })
    return false
  }
  const stop = `# Diagnosis\n\n${got.did}\n\n${got.why}\n\n# Stop\n\n${cut(maybe(root, plan.id, 'refusal.md') ?? '', TEXT_CHARS)}`
  if (to !== null && !(await repaired(db, root, plan, to, stop, Math.min(wall(db), FIX_WALL), provider))) {
    log(root, plan.id, { at: now.toISOString(), mode: m, ...got, tokens, applied: 'unrepaired' })
    return false
  }
  const applied = apply(db, root, plan, got, wire, now)
  log(root, plan.id, { at: now.toISOString(), mode: m, ...got, tokens, applied })
  const note = `fixer: ${got.did} → ${got.then}. ${got.why}`
  if (applied === 'escalated') {
    record(root, [{ at: now.toISOString(), plan: plan.id, ticket, kind: 'blocked', step: plan.step, name: 'fixer', note }])
    post(`CaliperForge · ${ticket} needs you`, `plan ${String(plan.id)}, step ${String(plan.step)}. ${note}`)
    mark(db, decision.id, 'escalated')
    return true
  }
  record(root, [{ at: now.toISOString(), plan: plan.id, ticket, kind: 'refused', step: plan.step, name: 'fixer', note }])
  mark(db, decision.id, 'applied')
  return true
}

async function ask(db: Db, root: string, plan: PlanRow, decision: { why: string }, m: Mode, to: string | null, provider: Provider):
  Promise<{ got: Fix | null; tokens: number }> {
  load(db, root)
  const { manifest, prompt, hash } = seat(root, 'fixer')
  const dir = planDir(root, plan.id)
  const tools = m === 'live' && to === null ? manifest.tools : manifest.tools.filter((t) => ['Read', 'Glob', 'Grep'].includes(t))
  const fired = await provider.fire({
    ...packet({ ...manifest, tools }, prompt, tight(root), issue(db, root, plan, decision, m, to), dir, pending(dir, 'fixer')),
    wall: Math.min(wall(db), FIX_WALL),
  })
  recorded(db, plan.id, plan.step, 'fixer', hash, provider.name, manifest, fired)
  return { got: fired.ended === 'completed' ? read(fired.text) : null, tokens: fired.usage.input + fired.usage.output }
}

/**
 * A reaped checkout needs no model: the builder takes it again on a fresh one.
 * Our own tickets only: an outside plan's re-cut can restore an old rehearsal branch, so those go to a person.
 */
const GONE: Fix = {
  did: 'nothing; the checkout is gone, so no step can run against it',
  then: 'rebuild',
  why: 'the builder takes it again on a fresh checkout; a branch it already pushed is restored from the fork',
}

function gone(root: string, plan: PlanRow): boolean {
  return plan.template === 'pr_path' && plan.origin !== null && plan.step >= 2 && !cloned(join(planDir(root, plan.id), 'src'))
}

/** `base.sha` stays so `checkout()` restores a pushed branch; `retries` stays: it names an outside plan's branch. */
function rebuild(db: Db, root: string, plan: PlanRow): string {
  if (maybe(root, plan.id, 'refusal.md') !== null) move(root, plan.id, 'refusal.md', 'refusal.prev.md')
  drop(root, plan.id, 'base.merged')
  rmSync(join(planDir(root, plan.id), 'src'), { recursive: true, force: true })
  db.transaction(() => {
    clear(db, plan.id)
    requeue(db, plan.id, 2)
  })()
  return 'rebuild'
}

/** The job it waits on must still be open, or nothing would ever release it. */
function awaits(db: Db, root: string, plan: PlanRow, f: Fix, now: Date): string {
  const on = f.waits_on ?? 0
  if (!waitable(db, on, plan.id)) return 'escalated'
  hold(db, root, plan.id, f.why, now, on)
  return `wait ${String(on)}`
}

/** A job held until a time goes back to its lane once that time has passed. */
function overdue(db: Db, root: string, now: Date): void {
  const at = now.toISOString()
  for (const r of lapsed(db, at)) {
    unhold(db, root, r.id, 'fixer')
    record(root, [{ at, plan: r.id, ticket: ticketOf(db, r.id), kind: 'refused', step: r.step, name: 'fixer',
      note: `held until ${r.held_until} passed, so this job is back in its lane` }])
  }
}

/** A job the fixer set waiting goes back to its lane when the other lands, and to a person if it never will. */
export function released(db: Db, root: string, now: Date, post: Post): void {
  overdue(db, root, now)
  for (const r of waitsEnded(db)) {
    const ticket = ticketOf(db, r.id)
    const at = now.toISOString()
    const ended = r.theirs === 'done' && !landed(db, r.on_) ? stuck(db, r.on_)[0] : { id: r.on_, state: r.theirs }
    if (ended === undefined) continue
    if (ended.state === 'done') {
      unhold(db, root, r.id, 'fixer')
      record(root, [{ at, plan: r.id, ticket, kind: 'refused', step: r.step, name: 'fixer', note: `plan ${String(r.on_)} landed, so this job is back in its lane` }])
      continue
    }
    clearWaitsOn(db, r.id)
    const note = `plan ${String(ended.id)}, which this job waits on, ended ${ended.state}`
    held(db, r.id, 'coo', note)
    record(root, [{ at, plan: r.id, ticket, kind: 'blocked', step: r.step, name: 'fixer', note }])
    post(`CaliperForge · ${ticket} needs you`, `plan ${String(r.id)}, step ${String(r.step)}. ${note}`)
  }
}

function apply(db: Db, root: string, plan: PlanRow, f: Fix, wire: Wire, now: Date): string {
  for (const path of f.add_files ?? []) listed(db, plan.id, path)
  if (plan.state !== 'blocked_on_ceo' && plan.state !== 'halted') return 'escalated'
  const to = f.answer === undefined ? undefined : rule(db, root, plan, 'fixer', f.answer)
  if (to === null) return 'escalated'
  switch (to === 'issue.md' && f.then === 'return' ? 'retry' : f.then) {
    case 'return': afresh(root, plan.id, returnToLane(db, plan.id, 'fixer')); return 'return'
    case 'retry': {
      const step = db.transaction(() => { clear(db, plan.id); return retry(db, plan) })()
      afresh(root, plan.id, step)
      return 'retry'
    }
    case 'done': {
      if (!pushed(db, plan.id)) return 'escalated'
      end(db, plan.id, 'done')
      return 'done'
    }
    case 'park': hold(db, root, plan.id, f.why, now, null, new Date(f.until ?? '')); return 'park'
    case 'wait': return awaits(db, root, plan, f, now)
    case 'rebuild': return gone(root, plan) ? rebuild(db, root, plan) : 'escalated'
    case 'ticket': {
      const url = ticketed(db, root, plan, f.ticket ?? f.why, `Filed by the fixer on plan ${String(plan.id)}.\n\n${f.why}\n\n${f.did}`,
        f.why, wire, now)
      event(db, { plan: plan.id, kind: 'ticket', actor: 'fixer', outcome: 'pass', message: f.why, pointer: url, run: null })
      return `ticket ${url}`
    }
    case 'ask_ceo': return 'escalated'
  }
}

function issue(db: Db, root: string, plan: PlanRow, decision: { why: string }, m: Mode, to: string | null): string {
  const said = maybe(root, plan.id, 'refusal.md') ?? maybe(root, plan.id, 'question.md') ?? 'none'
  const brief = maybe(root, plan.id, 'issue.md') ?? maybe(root, plan.id, 'ask.md') ?? 'none'
  const files = paths(db, plan.id).map((p) => `- ${p}`).join('\n') || 'none'
  const open = openJobs(db, plan.id)
    .map((r) => `- plan ${String(r.id)}, ${r.state}, step ${String(r.step)}, ${r.lane ?? '-'}, ${r.origin ?? 'no ticket'}: ${titleOf(root, r.id) ?? 'no title yet'}`)
    .join('\n') || 'none'
  const store = schema(db).map((s) => `${s};`).join('\n')
  const how = m === 'live' ? 'live: make the fix' : 'shadow: read only, change nothing, describe the fix under did'
  return [
    `# Mode\n\n${to === null ? how : `diagnose: read only, change nothing; ${to} makes the fix from your did and why`}`,
    `# Job\n\nplan ${String(plan.id)}, state ${plan.state}, step ${String(plan.step)}, lane ${plan.lane ?? '-'}, ${plan.origin ?? 'no ticket'}`,
    `# Orchestrator\n\nask_coo: ${decision.why}`,
    `# Stop\n\n${cut(said, TEXT_CHARS)}`,
    `# Brief's file list\n\n${files}`,
    `# Brief\n\n${cut(brief, TEXT_CHARS)}`,
    `# Open jobs\n\n${cut(open, TEXT_CHARS)}`,
    `# The machine's store\n\n\`\`\`sql\n${cut(store, STORE_CHARS)}\n\`\`\``,
  ].join('\n\n')
}

function read(text: string): Fix | null {
  const fence = /^---\n([\s\S]*?)\n---$/m.exec(text)?.[1]
  if (fence === undefined) return null
  const got = Fix.safeParse(prose(fence, ['did', 'then', 'why', 'ticket', 'answer']) ?? lines(fence))
  return got.success ? got.data : null
}


/** A colon inside \`did\` or \`why\` is prose: each line is its key up to the first colon, and a \`[a, b]\` value a list. */
function lines(fence: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of fence.split('\n').filter((l) => l.trim() !== '')) {
    const got = /^(\w+):\s*(.*)$/.exec(line)
    if (got === null) continue
    const value = (got[2] ?? '').trim()
    const list = /^\[(.*)\]$/.exec(value)
    out[got[1] ?? ''] = list === null ? value.replace(/^(["'])(.*)\1$/, '$2')
      : (list[1] ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '')
  }
  return out
}

function cut(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}\n\n[cut at ${String(n)} characters]`
}

const LOG = 'fixes.jsonl'

function log(root: string, plan: number, l: Logged): void {
  put(root, plan, LOG, `${(maybe(root, plan, LOG) ?? '')}${JSON.stringify(l)}\n`)
}

function logged(root: string, plan: number): Logged[] {
  const path = join(planDir(root, plan), LOG)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Logged)
}

