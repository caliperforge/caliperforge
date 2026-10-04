import { z } from 'zod'
import { put } from '../sequencer/workspace.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { LANE, LANES, laneOf, priorityOf, templatePriority, type Lane } from '../store/lanes.ts'
import type { Holder } from '../store/plans.ts'
import { profile } from '../store/profile.ts'
import { gh, type Read } from './gh.ts'
import type { Origin } from './queue.ts'

export { LANE, LANES, laneOf, priorityOf }

const REF = /^([^/\s]+\/[^/\s#]+)#(\d+)$/

const SEAT_LABEL = /^seat:([a-z][a-z0-9_]*)$/

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

export interface Filed {
  plan: number | null
  lane: Lane | null
  seat: string | null
  state: 'queued' | 'refused'
  why: string
  origin: Origin | null
  ruling: number | null
}

interface Unfiled {
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

export function seatOf(labels: { name: string }[]): string | null {
  return labels.map((l) => SEAT_LABEL.exec(l.name)?.[1]).find((n) => n !== undefined) ?? null
}

export function add(db: Db, root: string, ref: string, by: Holder | 'intake', pipe?: string, read: Read = gh): Filed {
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
  if (repo !== LANE[lane].home && profile(root, repo)?.lane !== lane) {
    return refusal(db, ref, 'plan.lane_home', `is on ${repo}; the ${lane} lane builds in ${LANE[lane].home}`)
  }
  const seat = seatOf(row.labels) ?? LANE[lane].seat
  const plan = file(db, by, pipe ?? LANE[lane].pipe, lane, seat, row.url, priority)
  put(root, plan, 'ask.md', `# ${row.title}\n\n${row.body}\n`)
  return { plan, lane, seat, state: 'queued', why: `${ref} queued on ${lane} for ${seat}`, origin: null, ruling: null }
}

/** Open caliperforge issues no plan row and no part of a split names: filed, not queued. */
export function unfiled(db: Db, read: Read = gh): Unfiled[] {
  const found = Found.parse(read(['search', 'issues', '--owner', 'caliperforge', '--state', 'open',
    '--limit', '100', '--json', 'number,title,url,repository,labels']))
  const known = seen(db)
  return found.filter((f) => !known.has(f.url))
    .map((f) => ({ repo: f.repository.nameWithOwner, no: f.number, title: f.title, url: f.url, lane: laneOf(f.labels) }))
}

export function seen(db: Db): Set<string> {
  return new Set((db.prepare('SELECT origin AS url FROM plans WHERE origin IS NOT NULL UNION SELECT url FROM parts').all() as
    { url: string }[]).map((r) => r.url))
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

export function file(db: Db, by: Holder | 'intake', pipe: string, lane: Lane, seat: string, url: string, priority: number | null): number {
  const held = db.prepare('SELECT id FROM plans WHERE origin = ?').get(url) as { id: number } | undefined
  if (held !== undefined) return held.id
  if (pipe === LANE[lane].pipe) {
    db.prepare("INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES (?, 0, '07:00', '22:00', 1)").run(pipe)
  }
  const row = db.prepare('SELECT id FROM pipes WHERE name = ?').get(pipe) as { id: number } | undefined
  if (row === undefined) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const template = LANE[lane].template
  const made = db.prepare(`INSERT INTO plans (pipe_id, template, state, queued_at, step, retries, priority, lane, seat, origin)
    VALUES (?, ?, 'queued', ?, 0, 0, ?, ?, ?, ?)`)
    .run(row.id, template, new Date().toISOString(), priority ?? templatePriority(db, template), lane, seat, url)
  const id = Number(made.lastInsertRowid)
  logged(db, { plan: id, kind: 'filed', actor: by, outcome: 'pass', message: url, pointer: null, run: null })
  return id
}
