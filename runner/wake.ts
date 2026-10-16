import { z } from 'zod'
import type { Refusal } from '../providers/kind.ts'
import { maybe } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { count, hhmm, lanes, wall, windows } from '../store/lanes.ts'
import { last } from '../store/merges.ts'
import { live, pipeOf, planById, PlanRow, planRows } from '../store/plans.ts'
import { openRefusals } from '../store/refusals.ts'
import { builtRuns } from '../store/runs.ts'
import { verdictRows } from '../store/verdict.ts'

export const CAP = 15_000

const Row = PlanRow.extend({ waits_on: z.int().nullable() })

type Row = z.infer<typeof Row>

type Cell = string | number | boolean | null

type Section = [string, string | null]

const CARD = ['id', 'state', 'template', 'lane', 'seat', 'priority', 'origin', 'wait_reason', 'waits_on']

export function wake(db: Db, root: string, plan: number, now = new Date()): { text: string } | { refusal: Refusal } {
  const row = Row.parse({ ...planById(db, plan), waits_on: planRows(db).find((r) => r.id === plan)?.waits_on ?? null })
  const all = sections(db, root, row, now)
  const missing = all.find(([, body]) => body === null)
  if (missing !== undefined) return refused(missing[0])
  const text = all.map(([name, body]) => `# ${name}\n\n${String(body)}`).join('\n\n')
  return Math.ceil(text.length / 4) > CAP ? refused('cap') : { text }
}

function sections(db: Db, root: string, row: Row, now: Date): Section[] {
  return [
    ['card', card(root, row)],
    ['step', fields(row, ['step', 'retries'])],
    ['verdict', verdict(db, root, row.id, row.state === 'blocked_on_ceo')],
    ['stop', stopped(root, row)],
    ['refusals', openRefusals(db, row.id).map((r) => line(r.step, r.fingerprint, r.at)).join('\n') || 'none'],
    ['runs', runs(db, row.id)],
    ['queue', queue(db, row)],
    ['lanes', fields(lanes(db, hhmm(db, now), now))],
    ['usage', windows(db).map((w) => line(w.kind, w.utilisation, w.status, w.resets_at)).join('\n')],
    ['base', base(db, root, row.id)],
  ]
}

function card(root: string, row: Row): string | null {
  const ask = maybe(root, row.id, 'ask.md')
  const waiting = row.wait_reason !== null || row.state === 'blocked_on_ceo'
  return !waiting || ask === null ? null : `${fields(row, CARD)}\n\n${ask}`
}

/** What stopped a plan for a person, in the words it was stopped with. */
const STOP_CHARS = 6000

function stopped(root: string, row: Row): string {
  if (row.state !== 'blocked_on_ceo') return 'none'
  const said = maybe(root, row.id, 'refusal.md') ?? maybe(root, row.id, 'question.md')
  if (said === null) return 'none'
  return said.length <= STOP_CHARS ? said : `${said.slice(0, STOP_CHARS)}\n\n[cut at ${String(STOP_CHARS)} characters]`
}

function verdict(db: Db, root: string, plan: number, blocked: boolean): string | null {
  const v = verdictRows(db, plan).at(-1)
  if (v === undefined) return blocked ? 'none' : null
  const head = line(v.gate, v.step, v.kind, v.outcome, v.origin_kind, v.origin_ref)
  if (v.kind !== 'review') return head
  const fence = /^---\n[\s\S]*?\n---/.exec(maybe(root, plan, `step-${String(v.step)}.verdict.md`) ?? '')?.[0]
  return fence === undefined ? null : `${head}\n\n${fence}`
}

function runs(db: Db, plan: number): string | null {
  const recent = builtRuns(db, plan).map((r) => line(r.step, r.seat, r.tokens))
  if (recent.length === 0) return null
  return [...recent, line('run.token_wall', wall(db)), line('plan.token_ceiling', count(db, 'plan.token_ceiling'))].join('\n')
}

function queue(db: Db, row: Row): string | null {
  const first = live(db, pipeOf(db, row.pipe_id)).at(0)
  return first === undefined ? 'none' : line(first.id, first.step, first.priority, first.wait_reason)
}

function base(db: Db, root: string, plan: number): string | null {
  const sha = maybe(root, plan, 'base.sha')
  if (sha === null) return null
  const merge = last(db, plan)
  return `${sha.trim()}\n${merge === null ? 'no merge from main yet' : line(merge.main, merge.overlap, merge.clean)}`
}

function line(...cells: Cell[]): string {
  return cells.map(String).join(' ')
}

function fields(o: Record<string, Cell>, keys = Object.keys(o)): string {
  return keys.map((k) => `${k}: ${String(o[k])}`).join('\n')
}

function refused(path: string): { refusal: Refusal } {
  return { refusal: { origin_kind: 'ruling', origin_ref: 'orchestrator.packet', path } }
}
