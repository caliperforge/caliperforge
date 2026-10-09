import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { picks } from '../sequencer/next.ts'
import { maybe } from '../sequencer/workspace.ts'
import { eventsOf } from '../store/events.ts'
import { idled, orphans, pushed, running, shut, stuck } from '../store/flow.ts'
import type { Db } from '../store/index.ts'
import { hhmm } from '../store/lanes.ts'
import { internal, openPipes, originRef, type PipeRow, planRows, PlanRow } from '../store/plans.ts'
import { all, record, ticketOf, type Event } from './inbox.ts'

const Row = PlanRow.extend({ waits_on: z.int().nullable() })

type Row = z.infer<typeof Row>

type Hit = [string, string] | null

interface Slack {
  pipe: PipeRow
  free: number
  startable: number
}

export function slack(db: Db, now: Date): Slack[] {
  return openPipes(db, hhmm(db, now)).map((pipe) =>
    ({ pipe, free: Math.max(pipe.max_concurrent - running(db, pipe.id), 0), startable: picks(db, pipe, now).filter((q) => q.state === 'queued').length }))
}

interface Finding { plan: number; step: number; what: string; fix: string }

const STAMP = '.cf/flow.at'

const HOUR = 60 * 60 * 1000

export function findings(db: Db, root: string, now: Date): Finding[] {
  const startable = new Set(slack(db, now).filter((s) => s.startable > 0).map((s) => s.pipe.id))
  return planRows(db).map((r) => Row.parse(r)).flatMap((p) => {
    const note = maybe(root, p.id, 'parked.md')
    const hit = landed(db, p) ?? stale(db, p, note) ?? halted(db, p) ?? repeated(db, p, note, now) ?? ownerless(p, note) ?? overlapped(p, startable)
    return hit === null ? [] : [{ plan: p.id, step: p.step, what: hit[0], fix: hit[1] }]
  })
}

export function flow(db: Db, root: string, now: Date): string[] {
  const plans = findings(db, root, now).map((f) => `plan ${String(f.plan)}\t${f.what}\t${f.fix}\n`)
  return [...plans, ...parts(db), ...idle(db)]
}

export function reported(db: Db, root: string, now: Date): void {
  if (openPipes(db, hhmm(db, now)).length === 0) return
  const stamp = join(root, STAMP)
  if (existsSync(stamp) && now.getTime() - Date.parse(readFileSync(stamp, 'utf8')) < HOUR) return
  mkdirSync(dirname(stamp), { recursive: true })
  writeFileSync(stamp, now.toISOString())
  const key = (e: Pick<Event, 'plan' | 'note'>): string => `${String(e.plan)}\t${e.note}`
  const known = new Set(all(root).filter((e) => e.kind === 'flow').map(key))
  record(root, findings(db, root, now)
    .map((f): Event => ({ at: now.toISOString(), plan: f.plan, ticket: ticketOf(db, f.plan), kind: 'flow', step: f.step, name: 'flow',
      note: `${f.what}: ${f.fix}` }))
    .filter((e) => !known.has(key(e))))
}

function landed(db: Db, p: Row): Hit {
  if (!internal(p) || (p.state !== 'blocked_on_ceo' && p.state !== 'halted')) return null
  return pushed(db, p.id) ? [`landed on main, state ${p.state}`, `cf return ${String(p.id)}`] : null
}

function stale(db: Db, p: Row, note: string | null): Hit {
  if (note === null) return null
  if (p.state === 'done' || p.state === 'refused' || p.state === 'halted') {
    return [`held, state ${p.state}`, `rm .cf/work/${String(p.id)}/parked.md`]
  }
  const ref = originRef(p)
  if (p.state !== 'blocked_on_ceo' || ref === null) return null
  return shut(db, ref.repo, ref.no) ?[`held on closed issue #${String(ref.no)}`, `cf unpark ${String(p.id)}`] : null
}

function halted(db: Db, p: Row): Hit {
  if (p.state !== 'halted') return null
  return [`halted: ${eventsOf(db, p.id, 'halted').at(-1)?.message ?? 'no reason recorded'}`, `cf return ${String(p.id)}`]
}

function repeated(db: Db, p: Row, note: string | null, now: Date): Hit {
  if (p.state !== 'blocked_on_ceo' || note !== null) return null
  return stuck(db, p.id, now) ? ['stopped on a repeated refusal', `cf retry ${String(p.id)}`] : null
}

function ownerless(p: Row, note: string | null): Hit {
  if (note === null || note.includes('/issues/') || p.state !== 'blocked_on_ceo' || p.waits_on !== null) return null
  return ['held with no owner', `cf unpark ${String(p.id)}`]
}

function overlapped(p: Row, startable: Set<number>): Hit {
  if (p.state !== 'running' || p.wait_reason !== 'file_overlap' || !startable.has(p.pipe_id)) return null
  const id = String(p.id)
  return p.waits_on === null ? ["holds a slot waiting on another job's files", `cf park ${id} --until <time>`]
    : [`holds a slot waiting on plan ${String(p.waits_on)}'s files`, `cf park ${id} --on ${String(p.waits_on)}`]
}

function parts(db: Db): string[] {
  return orphans(db).map((r) => `part #${String(r.number)}\tafter #${String(r.after)}, which is closed\tcf tick\n`)
}

function idle(db: Db): string[] {
  return idled(db).map((r) => `lane ${r.name}\tidle two ticks: ${String(r.free)} free, ${String(r.startable)} startable\tcf lanes\n`)
}
