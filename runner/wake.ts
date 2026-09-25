import { z } from 'zod'
import type { Refusal } from '../providers/kind.ts'
import { maybe } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { count, hhmm, lanes, wall, windows } from '../store/lanes.ts'
import { last } from '../store/merges.ts'
import { live, PipeRow, PlanRow } from '../store/plans.ts'

export const CAP = 15_000

const Row = PlanRow.extend({ waits_on: z.int().nullable() })

type Row = z.infer<typeof Row>

type Cell = string | number | boolean | null

type Section = [string, string | null]

const CARD = ['id', 'state', 'template', 'lane', 'seat', 'priority', 'origin', 'wait_reason', 'waits_on']

export function wake(db: Db, root: string, plan: number, now = new Date()): { text: string } | { refusal: Refusal } {
  const found = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan)
  const all: Section[] = found === undefined ? [['card', null]] : sections(db, root, Row.parse(found), now)
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
    ['refusals', rows(db, 'SELECT step, fingerprint, at FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0 ORDER BY id', row.id).join('\n') || 'none'],
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

/** #246: what stopped a plan for a person, in the words it was stopped with. The orchestrator cannot judge a stop it cannot read. */
export const STOP_CHARS = 6000

function stopped(root: string, row: Row): string {
  if (row.state !== 'blocked_on_ceo') return 'none'
  const said = maybe(root, row.id, 'refusal.md') ?? maybe(root, row.id, 'question.md')
  if (said === null) return 'none'
  return said.length <= STOP_CHARS ? said : `${said.slice(0, STOP_CHARS)}\n\n[cut at ${String(STOP_CHARS)} characters]`
}

function verdict(db: Db, root: string, plan: number, blocked: boolean): string | null {
  const v = db.prepare(`SELECT gate, step, kind, outcome, origin_kind, origin_ref FROM verdicts
    WHERE plan = ? ORDER BY id DESC LIMIT 1`).get(plan) as { step: number; kind: string } & Record<string, Cell> | undefined
  if (v === undefined) return blocked ? 'none' : null
  const head = line(...Object.values(v))
  if (v.kind !== 'review') return head
  const fence = /^---\n[\s\S]*?\n---/.exec(maybe(root, plan, `step-${String(v.step)}.verdict.md`) ?? '')?.[0]
  return fence === undefined ? null : `${head}\n\n${fence}`
}

function runs(db: Db, plan: number): string | null {
  const recent = rows(db, 'SELECT step, seat, input_tokens + output_tokens FROM runs WHERE plan = ? ORDER BY id DESC LIMIT 2', plan)
  if (recent.length === 0) return null
  return [...recent, line('run.token_wall', wall(db)), line('plan.token_ceiling', count(db, 'plan.token_ceiling'))].join('\n')
}

function queue(db: Db, row: Row): string | null {
  const first = live(db, PipeRow.parse(db.prepare('SELECT * FROM pipes WHERE id = ?').get(row.pipe_id))).at(0)
  return first === undefined ? 'none' : line(first.id, first.step, first.priority, first.wait_reason)
}

function base(db: Db, root: string, plan: number): string | null {
  const sha = maybe(root, plan, 'base.sha')
  if (sha === null) return null
  const merge = last(db, plan)
  return `${sha.trim()}\n${merge === null ? 'no merge from main yet' : line(merge.main, merge.overlap, merge.clean)}`
}

function rows(db: Db, sql: string, plan: number): string[] {
  return (db.prepare(sql).raw().all(plan) as Cell[][]).map((r) => line(...r))
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
