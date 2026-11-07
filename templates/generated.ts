import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CostWall } from '../providers/kind.ts'
import type { Seat } from '../runner/rules.ts'
import { NETWORK } from '../sequencer/checks.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { put } from '../sequencer/workspace.ts'
import { price } from '../store/brief.ts'
import { setting } from '../store/drift.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { credited } from '../store/runs.ts'
import { LOCKED } from '../store/timed.ts'
import { spawned } from '../store/transcript.ts'
import type { Bench, Sum } from './phases.ts'
import { degraded } from './powered.ts'

export function costWall(db: Db, provider: string, model: string): CostWall | Outcome {
  const usd = setting(db, 'bench.cost_wall_usd')
  if (usd === undefined) return { outcome: 'refuse', spans: ['bench.no_cost_wall'], note: 'no settings row bench.cost_wall_usd' }
  const prices = price(db, provider, model)
  if (prices === undefined) return { outcome: 'refuse', spans: ['bench.unpriced'], note: `no prices row for ${provider} ${model}` }
  return { usd: Number(usd), ...prices }
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

const REFIRE = 'refire.txt'

const MACHINE = ['machine_fault', 'coverage.no_revert_report']

export const refiring = <A extends [bench: Bench, manifest: Seat, hash: string, skill: string, handoffs: string, ...rest: unknown[]]>(run: (refire: string | undefined, ...args: A) => Promise<Sum | Outcome>) =>
  async (...args: A): Promise<Sum | Outcome> => {
    const path = join(args[4], REFIRE)
    const got = await run(existsSync(path) ? readFileSync(path, 'utf8') : undefined, ...args)
    if ('outcome' in got && got.spans.some((span) => MACHINE.includes(span))) writeFileSync(path, got.spans.join(', '))
    else rmSync(path, { force: true })
    return got
  }

export const refired = (bench: Bench, refire: string | undefined, resumed: boolean): Bench => resumed && refire !== undefined ? { ...bench, refire } : bench

export const net = (db: Db, plan: number, sum: Sum): number => sum.usd - credited(db, plan, sum.runs)

export function tallied(db: Db, plan: number, refire: string | undefined, sum: Sum, run: number): Sum {
  if (refire !== undefined) logged(db, { plan, kind: 'bench.credit', actor: 'machine', outcome: 'pass', message: refire, pointer: null, run })
  const runs = [...sum.runs, run]
  return { ...sum, machine: credited(db, plan, runs), runs }
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
  made: { suite: string; tokens: number; seconds: number; wall?: string; partial?: string; properties?: number }, note: string): Outcome {
  put(root, plan, 'generate.json', JSON.stringify({ ...made, x_ray: existsSync(join(dir, 'x-ray/x-ray.md')) ? 1 : 0, agents: agentsOf(transcripts) }))
  return { outcome: 'pass', spans: [], note: `generate.json written: ${note}` }
}
