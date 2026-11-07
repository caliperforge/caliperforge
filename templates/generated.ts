import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CostWall } from '../providers/kind.ts'
import { NETWORK } from '../sequencer/checks.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { put } from '../sequencer/workspace.ts'
import { price } from '../store/brief.ts'
import type { Db } from '../store/index.ts'
import { LOCKED } from '../store/timed.ts'
import { spawned } from '../store/transcript.ts'
import { degraded } from './powered.ts'

const BENCH_COST_WALL_USD = 40

export function costWall(db: Db, provider: string, model: string): CostWall | Outcome {
  const prices = price(db, provider, model)
  if (prices === undefined) return { outcome: 'refuse', spans: ['bench.unpriced'], note: `no prices row for ${provider} ${model}` }
  return { usd: BENCH_COST_WALL_USD, ...prices }
}

export function costWalled(stop: string | null): string | null {
  return stop !== null && ['ruling:run.cost_wall', 'ruling:run.repeat_read'].some((wall) => stop.startsWith(wall)) ? stop : null
}

export const faulted = <A extends unknown[], T>(run: (...args: A) => Promise<T | Outcome>) => async (...args: A): Promise<T | Outcome> => {
  try {
    return await run(...args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(LOCKED) || NETWORK.test(message)) throw error
    const first = message.split('\n')[0] ?? ''
    return { outcome: 'needs_coo', spans: ['machine_fault', `threw: ${first}`], note: `phase grading threw: ${first}`, message }
  }
}

function agentsOf(transcripts: string[]): number {
  return transcripts.reduce((n, transcript) => n + spawned(transcript), 0)
}

export function floored(name: string, tokens: number, transcripts: string[], properties: Outcome | number): Outcome | number {
  if (typeof properties !== 'number' || name !== 'fizz_generator') return properties
  const agents = agentsOf(transcripts)
  const why = degraded(properties, agents)
  return why === null ? properties : { outcome: 'refuse', spans: [`bench.${why}`],
    note: `${name} (completed, ${String(tokens)} tokens) spawned ${String(agents)} sub-agents and wrote ${String(properties)} properties`, to: 0 }
}

export function written(root: string, plan: number, dir: string, transcripts: string[],
  made: { suite: string; tokens: number; seconds: number; wall?: string; properties?: number }, note: string): Outcome {
  put(root, plan, 'generate.json', JSON.stringify({ ...made, x_ray: existsSync(join(dir, 'x-ray/x-ray.md')) ? 1 : 0, agents: agentsOf(transcripts) }))
  return { outcome: 'pass', spans: [], note: `generate.json written: ${note}` }
}
