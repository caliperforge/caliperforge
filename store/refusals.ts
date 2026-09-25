import { createHash } from 'node:crypto'
import type { Db } from './index.ts'

/** Refusals a plan takes before it waits for a person, however different each one is. */
export const ROUNDS = 6

/** Failed checkouts in a row before a blip is treated as a fault. */
export const BLIPS = 3

/** The first step that runs anything of main's. */
const BUILD = 2

export type Why = 'again' | 'shared' | 'repeat' | 'unchanged' | 'spent' | 'blips'

export interface Refused {
  plan: number
  step: number
  fingerprint: string
  diff: string | null
  /** A conflict with a moved main. Two jobs on the same files conflict alike, and one job can conflict
   * on the same paths twice as main keeps moving; `base.laps` caps the loop, so neither is a fault here. */
  moved?: true | undefined
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
 * took within a day (the fault is on main, and no build here can fix it), on one it has already had,
 * on a build that changed nothing since the last refusal, and past `ROUNDS`. Before the build nothing
 * of main has run, so a refusal there is never read as shared: two briefs refused alike are two
 * replies to two asks, and turned the internal lane off twice on 09-24. A branch behind main is never
 * read as shared either, because main moving is not a fault on main, and nor is a branch cut
 * again because main moved under it: that one goes round until `ROUNDS`, and `base.laps` caps it sooner.
 */
export function refused(db: Db, r: Refused): Why {
  const prior = db.prepare('SELECT fingerprint, diff FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0 ORDER BY id')
    .all(r.plan) as { fingerprint: string; diff: string | null }[]
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip) VALUES (?, ?, ?, ?, 0)')
    .run(r.plan, r.step, r.fingerprint, r.diff)
  const elsewhere = db.prepare(`SELECT 1 FROM refusals WHERE fingerprint = ? AND plan <> ? AND cleared = 0 AND blip = 0
    AND julianday(at) > julianday('now', '-1 day')`).get(r.fingerprint, r.plan)
  if (r.moved === true) return prior.length + 1 >= ROUNDS ? 'spent' : 'again'
  if (elsewhere !== undefined && r.step >= BUILD && r.fingerprint !== fingerprint(r.step, ['base:stale'])) return 'shared'
  if (prior.some((p) => p.fingerprint === r.fingerprint)) return 'repeat'
  if (r.diff !== null && prior.at(-1)?.diff === r.diff) return 'unchanged'
  return prior.length + 1 >= ROUNDS ? 'spent' : 'again'
}

/** A failed checkout: the plan stays on its step until `BLIPS` of them come in a row. */
export function blipped(db: Db, plan: number, step: number): Why {
  const rows = db.prepare('SELECT blip FROM refusals WHERE plan = ? AND cleared = 0 ORDER BY id DESC').all(plan) as { blip: number }[]
  const run = rows.findIndex((r) => r.blip === 0)
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip) VALUES (?, ?, ?, NULL, 1)')
    .run(plan, step, '0'.repeat(64))
  return (run === -1 ? rows.length : run) + 1 >= BLIPS ? 'blips' : 'again'
}

/**
 * CEO 09-21: a job halts past the token ceiling. The count starts again when a person sends it round,
 * so it is every run since the latest refusal a person cleared. Cache reads are not counted (CEO 09-24).
 */
export function overBudget(db: Db, plan: number): { spent: number; ceiling: number } | null {
  const row = db.prepare(`SELECT
      (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'plan.token_ceiling') AS ceiling,
      (SELECT coalesce(sum(r.input_tokens + r.output_tokens), 0) FROM runs r
        WHERE r.plan = ? AND julianday(r.at) > coalesce(
          (SELECT max(julianday(f.at)) FROM refusals f WHERE f.plan = ? AND f.cleared = 1), 0)) AS spent`)
    .get(plan, plan) as { ceiling: number | null; spent: number }
  return row.ceiling !== null && row.spent >= row.ceiling ? { spent: row.spent, ceiling: row.ceiling } : null
}

/** A person sent the plan round again: what it was refused for before no longer counts against it. */
export function clear(db: Db, plan: number): void {
  db.prepare('UPDATE refusals SET cleared = 1 WHERE plan = ?').run(plan)
}

export const WHY: Record<Exclude<Why, 'again'>, string> = {
  shared: 'another job was refused for the same failure within a day, so the fault is on main and this lane is off until a person looks',
  repeat: 'the same refusal came back, so another round would repeat it',
  unchanged: 'the build changed nothing since the last refusal',
  spent: `the plan has had ${String(ROUNDS)} refusals`,
  blips: `the checkout failed ${String(BLIPS)} times in a row`,
}
