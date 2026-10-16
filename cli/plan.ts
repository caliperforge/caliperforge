import { z } from 'zod'
import { wide } from '../sequencer/brief.ts'
import { put } from '../sequencer/workspace.ts'
import { commsLane, commsPlan, fileComms } from '../store/comms.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { LANE, LANES, laneOf, priorityOf, templatePriority, type Lane } from '../store/lanes.ts'
import { lanePipe, planOfOrigin, queueOrigin, seen } from '../store/origins.ts'
import { pipeNamed, type Holder } from '../store/plans.ts'
import { profile } from '../store/profile.ts'
import { rulingId } from '../store/rulings.ts'
import { unasked } from '../templates/research.ts'
import { gh, type Read } from './gh.ts'
import type { Origin } from './queue.ts'

export { LANE, LANES, laneOf, priorityOf, seen }

const REF = /^([^/\s]+\/[^/\s#]+)#(\d+)$/

const SEAT_LABEL = /^seat:([a-z][a-z0-9_]*)$/

const COMMS = '**Files:** comms desk rows only; no code'

const LISTED = /^\*\*Files:\*\*[ \t]*\r?\n((?:[ \t]*[-*][ \t].*(?:\r?\n|$))*)/m

const POST = /\b(?:(?:weekly|daily) \d{4}-\d{2}-\d{2}|ship post [^\s/#]+\/[^\s#]+#\d+)/

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

export function add(db: Db, root: string, ref: string, by: Holder | 'intake' | 'tick', pipe?: string, read: Read = gh): Filed {
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
  const missing = LANE[lane].template === 'research' ? unasked(row.body) : []
  if (missing.length > 0) return refusal(db, ref, 'plan.research_lines', `has no ${missing.join(' or ')} line`)
  if (row.body.includes(COMMS)) return desk(db, root, ref, row, by)
  const n = wide(`## Files\n${(LISTED.exec(row.body)?.[1] ?? '').replace(/\r/g, '')}`)
  if (n !== null) return refusal(db, ref, 'plan.wide', `split first: ${String(n)} files`)
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

export function render(row: Unfiled): string {
  return `${row.repo}#${String(row.no)}\t${row.lane ?? 'no lane'}\tfiled, not queued\t${row.title}\n`
}

function refusal(db: Db, ref: string, subject: string, why: string): Filed {
  const origin: Origin = { origin_kind: 'ruling', origin_ref: subject }
  return { plan: null, lane: null, seat: null, state: 'refused', why: `${ref} ${why}`, origin, ruling: rulingId(db, subject) }
}

function desk(db: Db, root: string, ref: string, row: z.infer<typeof Issue>, by: Holder | 'intake' | 'tick'): Filed {
  const title = POST.exec(row.body)?.[0]
  if (title === undefined) {
    return refusal(db, ref, 'plan.comms_title', 'names no post title (weekly|daily YYYY-MM-DD or ship post <owner/repo#n>)')
  }
  commsLane(db)
  const seat = seatOf(row.labels) ?? LANE.comms.seat
  const plan = fileComms(db, title, null, new Date().toISOString(), { origin: row.url, seat })
  if (plan === null) {
    return refusal(db, ref, 'plan.comms_title', `"${title}" is already filed as plan ${String(commsPlan(db, title) ?? planOfOrigin(db, row.url))}`)
  }
  logged(db, { plan, kind: 'filed', actor: by, outcome: 'pass', message: row.url, pointer: null, run: null })
  put(root, plan, 'ask.md', `# ${row.title}\n\n${row.body}\n`)
  return { plan, lane: 'comms', seat, state: 'queued', why: `${ref} queued on comms as "${title}"`, origin: null, ruling: null }
}

export function file(db: Db, by: Holder | 'intake' | 'tick', pipe: string, lane: Lane, seat: string, url: string, priority: number | null): number {
  const held = planOfOrigin(db, url)
  if (held !== null) return held
  if (pipe === LANE[lane].pipe) lanePipe(db, pipe)
  const row = pipeNamed(db, pipe)
  if (row === null) throw new Error(`no pipe "${pipe}"; cf pipe on ${pipe}`)
  const template = LANE[lane].template
  const id = queueOrigin(db, { pipe_id: row.id, template, priority: priority ?? templatePriority(db, template), lane, seat, origin: url })
  logged(db, { plan: id, kind: 'filed', actor: by, outcome: 'pass', message: url, pointer: null, run: null })
  return id
}
