import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CostWall } from '../providers/kind.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { put } from '../sequencer/workspace.ts'
import { price } from '../store/brief.ts'
import type { Db } from '../store/index.ts'
import { spawned } from '../store/transcript.ts'

const BENCH_COST_WALL_USD = 25

export function costWall(db: Db, provider: string, model: string): CostWall | Outcome {
  const prices = price(db, provider, model)
  if (prices === undefined) return { outcome: 'refuse', spans: ['bench.unpriced'], note: `no prices row for ${provider} ${model}` }
  return { usd: BENCH_COST_WALL_USD, ...prices }
}

export function costWalled(stop: string | null): string | null {
  return stop?.startsWith('ruling:run.cost_wall') === true ? stop : null
}

export function written(root: string, plan: number, dir: string, transcript: string,
  made: { suite: string; tokens: number; seconds: number; wall?: string; properties?: number }, note: string): Outcome {
  put(root, plan, 'generate.json', JSON.stringify({ ...made, x_ray: existsSync(join(dir, 'x-ray/x-ray.md')) ? 1 : 0, agents: spawned(transcript) }))
  return { outcome: 'pass', spans: [], note: `generate.json written: ${note}` }
}
