import { createHash } from 'node:crypto'
import type { Db } from './index.ts'
import { BUILT } from './plans.ts'

/** Refusals a plan takes before it waits for a person, however different each one is. */
export const ROUNDS = 6

/** Failed checkouts in a row before a blip is treated as a fault. */
export const BLIPS = 3

/** The first step that runs anything of main's. */
export const BUILD = 2

export type Why = 'again' | 'shared' | 'repeat' | 'unchanged' | 'spent' | 'blips'

export interface Refused {
  plan: number
  step: number
  fingerprint: string
  diff: string | null
  /** A conflict with a moved main. Two jobs on the same files conflict alike, and one job can conflict
   * on the same paths twice as main keeps moving; `base.laps` caps the loop, so neither is a fault here. */
  moved?: true | undefined
  /** A refusal only this job's own diff can cause, so another job taking it is no fault on main. */
  own?: true | undefined
  /** The sha256 of the ticket the builder works from: a ruling changes it, and the repeat check starts again. */
  ticket?: string | undefined
  span?: string | undefined
  note?: string | undefined
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const NAMED = /FAIL|×|✗|error|Error|expected|\.ts\b/

const TIMING = /\d+(\.\d+)?\s?m?s\b/g

/** A refusal's identity: the step, the spans it names and, for a failed check, the lines that say what failed. */
export function fingerprint(step: number, spans: string[], output = ''): string {
  const said = output.replace(ANSI, '').split('\n').filter((l) => NAMED.test(l))
    .map((l) => l.replace(TIMING, '').trim())
  return createHash('sha256').update([String(step), ...[...spans].sort(), '', ...new Set(said)].join('\n')).digest('hex')
}

/**
 * Records the refusal and says whether the plan goes round again. It stops on a refusal another job
 * took within a day (the fault is on main, and no build here can fix it), on one it has already had
 * against the same ticket, cleared or not, on a build that changed nothing since the last refusal, and past `ROUNDS`. Before the build nothing
 * of main has run, so a refusal there is never read as shared: two briefs refused alike are two
 * replies to two asks. A branch behind main is never
 * read as shared either, because main moving is not a fault on main, and nor is a branch cut
 * again because main moved under it: that one goes round until `ROUNDS`, and `base.laps` caps it sooner.
 */
export function refused(db: Db, r: Refused): Why {
  const prior = db.prepare('SELECT fingerprint, diff FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0 ORDER BY id')
    .all(r.plan) as { fingerprint: string; diff: string | null }[]
  const had = db.prepare('SELECT 1 FROM refusals WHERE plan = ? AND blip = 0 AND fingerprint = ? AND ticket IS ?')
    .get(r.plan, r.fingerprint, r.ticket ?? null) !== undefined
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip, ticket, span, note) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(r.plan, r.step, r.fingerprint, r.diff, r.ticket ?? null, r.span ?? null, r.note ?? null)
  const elsewhere = peer(db, r)
  if (r.moved === true) return prior.length + 1 >= ROUNDS ? 'spent' : 'again'
  if (r.own !== true && elsewhere !== undefined && r.step >= BUILD && r.fingerprint !== fingerprint(r.step, ['base:stale'])) return 'shared'
  if (had) return 'repeat'
  if (r.diff !== null && prior.at(-1)?.diff === r.diff) return 'unchanged'
  return prior.length + 1 >= ROUNDS ? 'spent' : 'again'
}

const repo = (p: string, t: string): string =>
  `coalesce(${t}.repo, replace(substr(${p}.origin, 1, instr(${p}.origin, '/issues/') - 1), 'https://github.com/', ''))`

/** Another plan in `r.plan`'s pipe and repo refused with the same fingerprint within a day, if one was. */
export function peer(db: Db, r: Refused): number | undefined {
  const row = db.prepare(`SELECT f.plan FROM refusals f JOIN plans p ON p.id = f.plan LEFT JOIN targets t ON t.id = p.target_id
      JOIN plans me ON me.id = ? LEFT JOIN targets mt ON mt.id = me.target_id
    WHERE f.fingerprint = ? AND f.plan <> me.id AND f.cleared = 0 AND f.blip = 0 AND julianday(f.at) > julianday('now', '-1 day')
      AND p.pipe_id = me.pipe_id AND ${repo('p', 't')} = ${repo('me', 'mt')}`).get(r.plan, r.fingerprint) as { plan: number } | undefined
  return row?.plan
}

/** The refusals recorded on `day` (local `yyyy-mm-dd`, `minutes` from UTC), blips left out, at local time. */
export function ofDay(db: Db, day: string, minutes: number): { id: number; plan: number; step: number; title: string | null; at: string }[] {
  const shift = `${String(minutes)} minutes`
  return db.prepare(`SELECT f.id, f.plan, f.step, p.title, datetime(f.at, ?) AS at FROM refusals f LEFT JOIN plans p ON p.id = f.plan
    WHERE f.blip = 0 AND date(f.at, ?) = ? ORDER BY f.id`)
    .all(shift, shift, day) as { id: number; plan: number; step: number; title: string | null; at: string }[]
}

/** Step 1 refusals on `pr_path` plans in the 7 UTC days ending on `now`'s, blips left out. */
export function briefRefusals(db: Db, now: Date): { day: string; span: string | null; note: string | null }[] {
  return db.prepare(`SELECT date(f.at) AS day, f.span, f.note FROM refusals f JOIN plans p ON p.id = f.plan
    WHERE f.blip = 0 AND f.step = 1 AND p.template = 'pr_path' AND date(f.at) BETWEEN date(?, '-6 days') AND date(?)`)
    .all(now.toISOString(), now.toISOString()) as { day: string; span: string | null; note: string | null }[]
}

export function refusalsOf(db: Db, plan: number): number {
  return (db.prepare('SELECT count(*) AS n FROM refusals WHERE plan = ? AND blip = 0').get(plan) as { n: number }).n
}

/** Builds that fired a model on the plan, however often a person cleared or retried it. */
export function builds(db: Db, plan: number): number {
  return db.prepare("SELECT count(*) FROM events WHERE plan = ? AND kind = 'build' AND run IS NOT NULL").pluck().get(plan) as number
}

/** Every refusal the plan had, newest first, cleared or not, blips left out. */
export function refusalRows(db: Db, plan: number): { step: number; span: string | null; note: string | null }[] {
  return db.prepare('SELECT step, span, note FROM refusals WHERE plan = ? AND blip = 0 ORDER BY id DESC')
    .all(plan) as { step: number; span: string | null; note: string | null }[]
}

/** The diff of the plan's newest refusal at `step`, cleared or not: a ruling clears refusals, and the diff is unchanged by it. */
export function diffAt(db: Db, plan: number, step: number): string | null {
  const row = db.prepare('SELECT diff FROM refusals WHERE plan = ? AND step = ? AND blip = 0 ORDER BY id DESC LIMIT 1')
    .get(plan, step) as { diff: string | null } | undefined
  return row?.diff ?? null
}

export function refusalAt(db: Db, plan: number, blip: number, at: string, fingerprint = '0'.repeat(64)): number {
  return Number(db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip, at) VALUES (?, 0, ?, NULL, ?, ?)')
    .run(plan, fingerprint, blip, at).lastInsertRowid)
}

/** A failed checkout: the plan stays on its step until `BLIPS` of them come in a row. */
export function blipped(db: Db, plan: number, step: number): Why {
  const rows = db.prepare('SELECT blip FROM refusals WHERE plan = ? AND cleared = 0 ORDER BY id DESC').all(plan) as { blip: number }[]
  const run = rows.findIndex((r) => r.blip === 0)
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip) VALUES (?, ?, ?, NULL, 1)')
    .run(plan, step, '0'.repeat(64))
  return (run === -1 ? rows.length : run) + 1 >= BLIPS ? 'blips' : 'again'
}

const SENT = (actors: string): string => `coalesce((SELECT max(julianday(e.at)) FROM events e WHERE e.plan = ?
  AND e.kind IN ('return', 'retry') AND e.actor IN (${actors})), 0)`

/**
 * A job halts past the token ceiling: the count starts again when a person sends it round,
 * so it is every run since the later of the latest refusal a person cleared and the latest
 * `return` or `retry` by `ceo`, `coo` or `director`. Cache reads are not counted.
 */
export function overBudget(db: Db, plan: number): { spent: number; ceiling: number } | null {
  const row = db.prepare(`SELECT
      (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'plan.token_ceiling') AS ceiling,
      (SELECT coalesce(sum(r.input_tokens + r.output_tokens), 0) FROM runs r
        WHERE r.plan = ? AND r.${BUILT} AND julianday(r.at) > max(coalesce(
          (SELECT max(julianday(f.at)) FROM refusals f WHERE f.plan = ? AND f.cleared = 1), 0),
          ${SENT("'ceo', 'coo', 'director'")})) AS spent`)
    .get(plan, plan, plan) as { ceiling: number | null; spent: number }
  return row.ceiling !== null && row.spent >= row.ceiling ? { spent: row.spent, ceiling: row.ceiling } : null
}

/** The director has sent the plan round since a person last did. */
export function sentOnce(db: Db, plan: number): boolean {
  return db.prepare(`SELECT ${SENT("'director'")} > ${SENT("'ceo', 'coo'")}`).pluck().get(plan, plan) === 1
}

/** The plan's newest refusal within a day of `now`, and each plan refused alike in that day, cleared or not. */
export function alike(db: Db, plan: number, now: Date): { step: number; fingerprint: string; plans: number[] } | null {
  const day = "blip = 0 AND julianday(at) > julianday(?, '-1 day')"
  const at = now.toISOString()
  const row = db.prepare(`SELECT step, fingerprint FROM refusals WHERE plan = ? AND ${day} ORDER BY id DESC LIMIT 1`)
    .get(plan, at) as { step: number; fingerprint: string } | undefined
  if (row === undefined || row.fingerprint === fingerprint(row.step, ['base:stale'])) return null
  const plans = db.prepare(`SELECT DISTINCT plan FROM refusals WHERE step = ? AND fingerprint = ? AND ${day} ORDER BY plan`)
    .pluck().all(row.step, row.fingerprint, at) as number[]
  return { ...row, plans }
}

/** A person sent the plan round again: its round count starts over, but a refusal it already had still stops it. */
export function clear(db: Db, plan: number): void {
  db.prepare('UPDATE refusals SET cleared = 1 WHERE plan = ?').run(plan)
}

export function clearedOf(db: Db, plan: number): number[] {
  return db.prepare('SELECT cleared FROM refusals WHERE plan = ? ORDER BY id').pluck().all(plan) as number[]
}

export const WHY: Record<Exclude<Why, 'again'>, string> = {
  shared: 'another job was refused for the same failure within a day, so the fault is on main and this lane is off until a person looks',
  repeat: 'the same refusal came back, so another round would repeat it',
  unchanged: 'the build changed nothing since the last refusal',
  spent: `the plan has had ${String(ROUNDS)} refusals`,
  blips: `the checkout failed ${String(BLIPS)} times in a row`,
}
