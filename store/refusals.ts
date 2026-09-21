import { createHash } from 'node:crypto'
import type { Db } from './index.ts'

/** Refusals a plan takes before it waits for a person, however different each one is. */
export const ROUNDS = 6

/** Failed checkouts in a row before a blip is treated as a fault. */
export const BLIPS = 3

export type Why = 'again' | 'repeat' | 'unchanged' | 'spent' | 'blips'

export interface Refused {
  plan: number
  step: number
  fingerprint: string
  diff: string | null
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
 * Records the refusal and says whether the plan goes round again. It stops on a refusal it has
 * already had, on a build that changed nothing since the last refusal, and past `ROUNDS`.
 */
export function refused(db: Db, r: Refused): Why {
  const prior = db.prepare('SELECT fingerprint, diff FROM refusals WHERE plan = ? AND cleared = 0 AND blip = 0 ORDER BY id')
    .all(r.plan) as { fingerprint: string; diff: string | null }[]
  db.prepare('INSERT INTO refusals (plan, step, fingerprint, diff, blip) VALUES (?, ?, ?, ?, 0)')
    .run(r.plan, r.step, r.fingerprint, r.diff)
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

/** A person sent the plan round again: what it was refused for before no longer counts against it. */
export function clear(db: Db, plan: number): void {
  db.prepare('UPDATE refusals SET cleared = 1 WHERE plan = ?').run(plan)
}

export const WHY: Record<Exclude<Why, 'again'>, string> = {
  repeat: 'the same refusal came back, so another round would repeat it',
  unchanged: 'the build changed nothing since the last refusal',
  spent: `the plan has had ${String(ROUNDS)} refusals`,
  blips: `the checkout failed ${String(BLIPS)} times in a row`,
}
