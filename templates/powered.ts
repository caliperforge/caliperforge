import { FLOOR } from '../cli/underpowered.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { put } from '../sequencer/workspace.ts'
import type { Event } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { record, type Score, supersede } from '../store/bench.ts'

type Keys = Pick<Score, 'target' | 'generator'>

const AGENTS = 8

const PROPERTIES = 3

export function powered(properties: number, agents = 0, { pre_fix = null, fix = null }: { pre_fix?: number | null; fix?: number | null } = {}, failed = false, refuzz = false): Score['not_powered'] {
  if (failed) return 'compile_failed'
  if (agents < AGENTS) return 'reduced_generate'
  if (properties < PROPERTIES) return 'few_properties'
  if (refuzz) return null
  if (pre_fix === null || pre_fix < FLOOR) return 'pre_fix_calls'
  return fix === null || fix < FLOOR ? 'fix_calls' : null
}

const UNCOUNTED: Score['not_powered'][] = ['compile_failed', 'wall', 'reduced_generate', 'few_properties']

/** Why a run does not count, or null when it compiled, is powered and every critic event passed. */
export function counted(notPowered: Score['not_powered'], critic: Event['outcome'][]): string | null {
  if (UNCOUNTED.includes(notPowered)) return notPowered
  if (critic.length === 0) return 'no_critic'
  return critic.includes('refuse') ? 'not_clean' : null
}

export function buildError(rows: { build_log_tail?: unknown }[]): string | null {
  const lines = rows.flatMap((r) => (typeof r.build_log_tail === 'string' ? r.build_log_tail.split('\n') : []))
  return lines.find((line) => /error/i.test(line))?.trim() ?? null
}

export function walled(db: Db, root: string, plan: number, keys: Keys, made: Pick<Score, 'tokens' | 'seconds' | 'x_ray'>, wall: string): Outcome {
  kept(db, root, plan, keys, { catches: 0, false_positives: 0, untested: null, ...made, pre_fix_calls: null, fix_calls: null, not_powered: 'wall' })
  return { outcome: 'pass', spans: [], note: `score.json written unscored: generate stopped at ${wall}` }
}

/** `fuzz_bench` is left out of score.json when `sha` is undefined, as JSON.stringify drops it. */
export function kept(db: Db, root: string, plan: number, keys: Keys, score: Omit<Score, 'plan' | 'target' | 'generator'>, sha?: string, noted: object = {}): void {
  supersede(db, plan)
  record(db, { plan, ...keys, ...score })
  put(root, plan, 'score.json', JSON.stringify({ fuzz_bench: sha, ...score, ...noted }))
}
