import { z } from 'zod'
import { put } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { templatePriority } from '../store/lanes.ts'
import { DEFAULT_BUILDER } from '../templates/pr-path.ts'
import { gh, type Read } from './gh.ts'
import type { Origin } from './queue.ts'

const REF = /^([^/\s]+\/[^/\s#]+)#(\d+)$/

const SEAT_LABEL = /^seat:([a-z][a-z0-9_]*)$/

const LANE_LABEL = /^lane:([a-z]+)$/

const PRIORITY_LABEL = /^P([0-9])$/

const Issue = z.object({
  number: z.int(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  labels: z.array(z.object({ name: z.string() })),
})

const Found = z.array(z.object({
  number: z.int(),
  title: z.string(),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  labels: z.array(z.object({ name: z.string() })),
}))

export const LANES = ['machine', 'atelier', 'comms', 'research'] as const

export type Lane = typeof LANES[number]

export type Template = 'pr_path' | 'research' | 'comms'

/** The template each lane files on, and the seat that template falls to when no `seat:` label names one. */
const LANE: Record<Lane, { template: Template; seat: string }> = {
  machine: { template: 'pr_path', seat: DEFAULT_BUILDER },
  atelier: { template: 'pr_path', seat: DEFAULT_BUILDER },
  comms: { template: 'comms', seat: DEFAULT_BUILDER },
  research: { template: 'research', seat: DEFAULT_BUILDER },
}

export interface Filed {
  plan: number | null
  lane: Lane | null
  seat: string | null
  state: 'queued' | 'refused'
  why: string
  origin: Origin | null
  ruling: number | null
}

export interface Unfiled {
  repo: string
  no: number
  title: string
  url: string
  lane: Lane | null
}

export function parse(ref: string): { repo: string; no: number } {
  const hit = REF.exec(ref)
  if (hit === null) throw new Error(`"${ref}" is not an <owner/repo>#<n> issue reference`)
  return { repo: String(hit[1]), no: Number(hit[2]) }
}

export function issue(repo: string, no: number, read: Read = gh): z.infer<typeof Issue> {
  return Issue.parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'number,title,body,url,labels']))
}

export function laneOf(labels: { name: string }[]): Lane | null {
  const named = labels.map((l) => LANE_LABEL.exec(l.name)?.[1]).find((n) => n !== undefined)
  return LANES.find((l) => l === named) ?? null
}

export function seatOf(labels: { name: string }[]): string | null {
  return labels.map((l) => SEAT_LABEL.exec(l.name)?.[1]).find((n) => n !== undefined) ?? null
}

/** The priority the issue's one `P0`-`P9` label names: `null` for none, and refused for more than one. */
export function priorityOf(labels: { name: string }[]): number | null {
  const held = labels.map((l) => PRIORITY_LABEL.exec(l.name)).filter((hit) => hit !== null)
  if (held.length > 1) throw new Error(`carries ${held.map((hit) => hit[0]).join(' and ')}; one priority label at most`)
  const one = held[0]
  return one === undefined ? null : Number(one[1])
}

export function add(db: Db, root: string, ref: string, pipe: string, read: Read = gh): Filed {
  const { repo, no } = parse(ref)
  const row = issue(repo, no, read)
  const lane = laneOf(row.labels)
  if (lane === null) {
    return refusal(db, ref, 'plan.lane_label', `carries no lane label; add one of ${LANES.map((l) => `lane:${l}`).join(', ')}`)
  }
  let priority: number | null
  try {
    priority = priorityOf(row.labels)
  } catch (error) {
    return refusal(db, ref, 'plan.priority_label', error instanceof Error ? error.message : String(error))
  }
  const seat = seatOf(row.labels) ?? LANE[lane].seat
  const plan = file(db, pipe, lane, seat, row.url, priority)
  put(root, plan, 'ask.md', `# ${row.title}\n\n${row.body}\n`)
  return { plan, lane, seat, state: 'queued', why: `${ref} queued on ${lane} for ${seat}`, origin: null, ruling: null }
}

/** Open caliperforge issues no plan row and no part of a split names: filed, not queued. */
export function unfiled(db: Db, read: Read = gh): Unfiled[] {
  const found = Found.parse(read(['search', 'issues', '--owner', 'caliperforge', '--state', 'open',
    '--limit', '100', '--json', 'number,title,url,repository,labels']))
  const seen = new Set((db.prepare('SELECT origin AS url FROM plans WHERE origin IS NOT NULL UNION SELECT url FROM parts').all() as
    { url: string }[]).map((r) => r.url))
  return found.filter((f) => !seen.has(f.url))
    .map((f) => ({ repo: f.repository.nameWithOwner, no: f.number, title: f.title, url: f.url, lane: laneOf(f.labels) }))
}

export function render(row: Unfiled): string {
  return `${row.repo}#${String(row.no)}\t${row.lane ?? 'no lane'}\tfiled, not queued\t${row.title}\n`
}

function refusal(db: Db, ref: string, subject: string, why: string): Filed {
  const origin: Origin = { origin_kind: 'ruling', origin_ref: subject }
  return { plan: null, lane: null, seat: null, state: 'refused', why: `${ref} ${why}`, origin, ruling: ruling(db, subject) }
}

function ruling(db: Db, subject: string): number | null {
  const row = db.prepare('SELECT id FROM rulings WHERE subject = ? ORDER BY id DESC LIMIT 1')
    .get(subject) as { id: number } | undefined
  return row?.id ?? null
}

function file(db: Db, pipe: string, lane: Lane, seat: string, url: string, priority: number | null): number {
  const held = db.prepare('SELECT id FROM plans WHERE origin = ?').get(url) as { id: number } | undefined
  if (held !== undefined) return held.id
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number } | undefined
  if (row === undefined) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const template = LANE[lane].template
  const made = db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(row.id, template, new Date().toISOString(), priority ?? templatePriority(db, template), lane, seat, url)
  return Number(made.lastInsertRowid)
}
