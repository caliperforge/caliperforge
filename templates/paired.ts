import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { needsCeo, planById, type PlanRow } from '../store/plans.ts'

export function heldForCoo(db: Db, plan: PlanRow, ran: SpawnSyncReturns<string>, script: string): Outcome {
  const { state } = planById(db, plan.id)
  const live = state === 'queued' || state === 'running'
  const stop = !live ? `the plan is ${state}` : ran.signal === null ? null : `killed by ${ran.signal}`
  const note = stop === null ? (ran.error?.message ?? ran.stderr.trim().split('\n').at(-1) ?? '') : `${script}.py stopped: ${stop}`
  if (stop === null) needsCeo(db, plan, note)
  logged(db, { plan: plan.id, kind: 'score', actor: 'score', outcome: stop === null ? 'needs_coo' : 'pass', message: note, pointer: `step-${String(plan.step)}`, run: null })
  return { outcome: 'pass', held: true, quiet: true, spans: [`bench.${script}`], note }
}

export interface Row { property?: string; verdict?: string; untested?: boolean; calls?: { pre_fix?: number | null; fix?: number | null }; build_log_tail?: unknown }

export function rows(path: string): Row[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Row)
}

const DEEP = /too deep in the stack|stack too deep/i

/** run_pair under the generator's `[profile.fuzz]` as `FOUNDRY_*`, and once more via IR when every row failed stack-too-deep. */
export function profiled(db: Db, plan: PlanRow, bench: string, target: string, suites: string, src: string, seeds: number): Outcome | Ran & { retried: boolean } {
  const carried = join(bench, suites, 'root/foundry.toml')
  const toml = [carried, join(src, 'foundry.toml')].find((path) => existsSync(path))
  const env = fuzzEnv(toml === undefined ? '' : readFileSync(toml, 'utf8'))
  const ran = paired(db, plan, bench, target, suites, seeds, env)
  if ('outcome' in ran) return ran
  const pairs = ran.runs.flat()
  const deep = pairs.every((r) => r.verdict === 'error') && pairs.some((r) => typeof r.build_log_tail === 'string' && DEEP.test(r.build_log_tail))
  if (!deep || env.FOUNDRY_VIA_IR === 'true') return { ...ran, retried: false }
  const again = paired(db, plan, bench, target, suites, seeds, { ...env, FOUNDRY_VIA_IR: 'true' })
  return 'outcome' in again ? again : { ...again, retried: true }
}

function fuzzEnv(toml: string): Record<string, string> {
  const section = toml.split(/^(?=[ \t]*\[)/m).find((s) => /^[ \t]*\[profile\.fuzz\]/.test(s)) ?? ''
  return Object.fromEntries([...section.matchAll(/^[ \t]*(\w+)[ \t]*=[ \t]*([^\s[{].*?)[ \t]*$/gm)]
    .map((m) => [`FOUNDRY_${(m[1] ?? '').toUpperCase()}`, (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')]))
}

interface Ran { runs: Row[][]; seconds: number[] }

/** run_pair once per seed, timed, with that seed's rows moved to `<target>.seed-<k>.jsonl`. */
function paired(db: Db, plan: PlanRow, bench: string, target: string, suites: string, seeds: number, env: Record<string, string>): Outcome | Ran {
  const written = join(bench, 'results', target, `${target}.jsonl`)
  const ran: Ran = { runs: [], seconds: [] }
  for (let seed = 1; seed <= seeds; seed++) {
    rmSync(written, { force: true })
    const start = performance.now()
    const spawned = spawnSync('python3', ['bench/run_pair.py', `targets/${target}.yml`, suites], { cwd: bench, encoding: 'utf8', env: { ...process.env, ...env } })
    if (spawned.error !== undefined || spawned.status !== 0) return heldForCoo(db, plan, spawned, 'run_pair')
    if (!existsSync(written)) return { outcome: 'refuse', spans: ['bench.no_results'], note: `run_pair.py exited 0 and wrote no results/${target}/${target}.jsonl` }
    const pairs = rows(written)
    if (pairs.length === 0) return { outcome: 'refuse', spans: ['bench.empty_results'], note: `results/${target}/${target}.jsonl has no rows` }
    renameSync(written, join(bench, 'results', target, `${target}.seed-${String(seed)}.jsonl`))
    ran.runs.push(pairs)
    ran.seconds.push((performance.now() - start) / 1000)
  }
  return ran
}

/** A property's union verdict is the first of these that any seed gave it. */
const UNION = ['fp_candidate', 'catch', 'silent'] as const

export function seedsOf(runs: Row[][], seconds: number[]) {
  const seeds = runs.map((pairs, at) => ({ seed: at + 1, ...tallied(pairs.map((r) => r.verdict)),
    calls: { pre_fix: pairs[0]?.calls?.pre_fix ?? null, fix: pairs[0]?.calls?.fix ?? null }, seconds: seconds[at] ?? null }))
  const said = new Map<string | undefined, (string | undefined)[]>()
  for (const r of runs.flat()) said.set(r.property, [...(said.get(r.property) ?? []), r.verdict])
  const folded = (side: 'pre_fix' | 'fix', fold: (calls: number[]) => number): number | null =>
    (seeds.some((s) => s.calls[side] === null) ? null : fold(seeds.map((s) => s.calls[side] ?? 0)))
  const summed = (calls: number[]): number => calls.reduce((n, c) => n + c, 0)
  return { seeds, union: tallied([...said.values()].map((verdicts) => UNION.find((v) => verdicts.includes(v)))),
    calls: { pre_fix: folded('pre_fix', summed), fix: folded('fix', summed) }, least: { pre_fix: folded('pre_fix', (calls) => Math.min(...calls)), fix: folded('fix', (calls) => Math.min(...calls)) } }
}

function tallied(verdicts: (string | undefined)[]): Record<(typeof UNION)[number], number> {
  return { catch: verdicts.filter((v) => v === 'catch').length, fp_candidate: verdicts.filter((v) => v === 'fp_candidate').length,
    silent: verdicts.filter((v) => v === 'silent').length }
}
