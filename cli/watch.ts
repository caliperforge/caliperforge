import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostValue } from '../providers/credential.ts'
import type { Db } from '../store/index.ts'
import { hhmm, zone } from '../store/lanes.ts'
import { clock, inWindow, openPipes, PipeRow } from '../store/plans.ts'

/** #251. Inside an open window a real tick lands every minute; ten without one means the machine is down, not idle. */
export const STALE_MINUTES = 10

/** The note a tick that threw leaves on its receipt, so a crash reads as one in the table and not as a quiet minute. */
export const CRASHED = 'crashed: '

/** Set while an alert is out, so a stall alerts once and its end alerts once. */
const MARK = '.cf/watch.alerted'

const LANES = '.cf/watch.lanes'

export interface Liveness {
  at: string | null
  minutes: number | null
  crash: string | null
  stale: boolean
}

export function liveness(db: Db, now: Date): Liveness {
  const open = openPipes(db, hhmm(db, now)).length > 0
  const row = db.prepare('SELECT at, note FROM ticks WHERE dry = 0 ORDER BY at DESC LIMIT 1').get() as
    { at: string; note: string } | undefined
  if (row === undefined) return { at: null, minutes: null, crash: null, stale: open }
  const minutes = Math.floor((now.getTime() - Date.parse(row.at)) / 60000)
  const crash = row.note.startsWith(CRASHED) ? row.note.slice(CRASHED.length) : null
  return { at: row.at, minutes, crash, stale: open && (crash !== null || minutes > STALE_MINUTES) }
}

export function livenessLine(db: Db, l: Liveness): string {
  if (l.at === null) return `tick\t${l.stale ? 'DOWN: no real tick on record' : 'no real tick on record'}\n`
  const when = `${clock(new Date(l.at), zone(db))} (${String(l.minutes)} min ago)`
  if (l.crash !== null) return `tick\tDOWN: last real tick ${when} crashed: ${l.crash.split('\n')[0] ?? ''}\n`
  return `tick\t${l.stale ? 'DOWN: ' : ''}last real tick ${when}\n`
}

export type Post = (title: string, body: string) => void

/**
 * A lane the shared-failure rule switched off keeps ticking with nothing to fire: alive, and stalled. On 09-25
 * two false run-wall stops turned `internal` off at 08:21 and five jobs sat until 08:55 with every tick green.
 */
export function stalledLanes(db: Db, now: Date): string[] {
  const at = hhmm(db, now)
  const rows = db.prepare(`SELECT p.*, count(pl.id) AS jobs FROM pipes p JOIN plans pl ON pl.pipe_id = p.id
    WHERE p.enabled = 0 AND pl.state IN ('queued', 'running') GROUP BY p.id ORDER BY p.id`).all() as (Record<string, unknown> & { jobs: number })[]
  return rows.filter((r) => inWindow(PipeRow.parse({ ...r, jobs: undefined }), at))
    .map((r) => `${String(r.name)} (${String(r.jobs)} job${r.jobs === 1 ? '' : 's'} waiting)`)
}

/** One alert when the machine goes down and one when it comes back; every run in between is silent. */
export function watch(db: Db, root: string, now: Date, post: Post): Liveness {
  const l = liveness(db, now)
  const mark = join(root, MARK)
  if (l.stale && !existsSync(mark)) {
    post('CaliperForge · the machine is down', livenessLine(db, l).replace(/^tick\t(DOWN: )?/, '').trim())
    mkdirSync(dirname(mark), { recursive: true })
    writeFileSync(mark, now.toISOString())
  } else if (!l.stale && existsSync(mark)) {
    post('CaliperForge · the machine is running again', livenessLine(db, l).replace(/^tick\t/, '').trim())
    rmSync(mark)
  }
  lanes(db, root, now, post)
  return l
}

function lanes(db: Db, root: string, now: Date, post: Post): void {
  const off = stalledLanes(db, now)
  const mark = join(root, LANES)
  const was = existsSync(mark)
  if (off.length > 0 && !was) {
    post('CaliperForge · a lane is off with work in it', `${off.join(', ')}. A shared failure switched it off; cf pipe on <lane> once it is looked at.`)
    mkdirSync(dirname(mark), { recursive: true })
    writeFileSync(mark, off.join('\n'))
  } else if (off.length === 0 && was) {
    rmSync(mark)
  }
}

/** The desktop banner, and an iMessage when the host's env file names `IMESSAGE_NOTIFY_TO`: the channel that reaches a phone. */
export function alerter(to: string | null = hostValue('IMESSAGE_NOTIFY_TO')): Post {
  return (title, body) => {
    banner(title, body)
    if (to !== null) imessage(to, `${title}\n${body}`)
  }
}

function banner(title: string, body: string): void {
  osascript(`display notification ${quote(body.slice(0, 180))} with title ${quote(title)}`)
}

function imessage(to: string, body: string): void {
  osascript(['tell application "Messages"', 'set s to 1st account whose service type = iMessage',
    `send ${quote(body.slice(0, 600))} to participant ${quote(to)} of s`, 'end tell'].join('\n'))
}

function quote(s: string): string {
  return JSON.stringify(s)
}

/** A missing permission or a closed Messages must never be what stops a tick. */
function osascript(script: string): void {
  if (process.platform !== 'darwin' || process.env.VITEST !== undefined) return
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 15000 })
  } catch {
    return
  }
}
