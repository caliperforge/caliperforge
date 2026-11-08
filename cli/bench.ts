import type { Command } from 'commander'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { staffing } from '../sequencer/staffing.ts'
import { render, sessionDir, split } from '../sequencer/subagents.ts'
import { get, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { supersede } from '../store/bench.ts'
import { eventsOf, logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { addPlan, briefed, holderOf, pipeNamed, planById, plansOf, rewind, type Holder } from '../store/plans.ts'
import { refusalRows } from '../store/refusals.ts'
import { generated, lastTranscript, runTokens } from '../store/runs.ts'
import { copied, medusa } from '../templates/bench.ts'
import { dried, regraded } from '../templates/dry.ts'
import { phasesOf } from '../templates/phases.ts'
import { profiled } from '../templates/profile.ts'
import { placed, rooted } from '../templates/rooted.ts'
import { type Config, prebuilt, reusing } from '../templates/smoke.ts'
import type { Cli } from './cf-lanes.ts'

export function fileBench(db: Db, root: string, target: string | undefined, all: boolean, generator: string, at: string, stop?: string, why?: string): number[] {
  const row = staffing(root).find((r) => r.template === 'bench' && r.step === 1 && (r.key === generator || r.seat === generator))
  const key = row?.key
  if (row === undefined || key === undefined) throw new Error(`${generator} is not a bench generator in rules/staffing.yaml`)
  const { seat } = row
  if (all === (target !== undefined)) throw new Error('cf bench file takes <target> or --all')
  if (stop !== undefined) {
    const list = phasesOf(join(root, 'seats/fizz_lean_generator/skill')).slice(0, -1)
    if (seat !== 'fizz_lean_generator' || !list.includes(stop)) throw new Error(`--stop-after takes one of ${list.join(', ')} on fizz_lean_generator`)
  }
  const pipe = pipeNamed(db, 'bench')
  if (pipe === null) throw new Error('no pipe "bench"')
  const dir = mkdtempSync(join(tmpdir(), 'cf-fuzz-bench-'))
  try {
    git(dir, ['clone', '-q', remote(gitBase(root), 'caliperforge/fuzz-bench'), 'fuzz-bench'])
    const targets = join(dir, 'fuzz-bench/targets')
    const names = target !== undefined ? [target] : readdirSync(targets).filter((f) => f.endsWith('.yml')).sort().map((f) => f.slice(0, -4))
    const missing = names.find((name) => !existsSync(join(targets, `${name}.yml`)))
    if (missing !== undefined) throw new Error(`fuzz-bench has no targets/${missing}.yml`)
    const refused = target === undefined ? undefined : noSuite(db, root, target, key)
    if (refused !== undefined) throw new Error(`${String(target)}: plan ${String(refused)} refused at step 1 with bench.no_suite`)
    const filed = names.filter((name) => noSuite(db, root, name, key) === undefined)
    const gated = seat === 'fizz_lean_generator'
    if (gated && why === undefined) regateable(db, root, filed, key)
    return filed.map((name) => {
      const id = addPlan(db, { pipe_id: pipe.id, target_id: null, template: 'bench', state: 'queued', queued_at: at, lane: null, seat: null, origin: null, step: 0 })
      briefed(db, id, { title: `Bench: score ${key} on ${name} (catch / miss / false alarm)`, what: null, why: null, ends: null })
      if (gated && why !== undefined) logged(db, { plan: id, kind: 'bench.regrade_waived', actor: 'coo', outcome: 'pass', message: why, pointer: null, run: null })
      put(root, id, 'target.yml', `${copied(readFileSync(join(targets, `${name}.yml`), 'utf8'), name, key)}${stop === undefined ? '' : `stop_after: ${stop}\n`}`)
      return id
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const field = (yml: string, key: string): string | undefined => [...yml.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))].at(-1)?.[1]

const latest = (db: Db, root: string, name: string, key: string): number | undefined => plansOf(db, 'bench').reverse().find(({ id }) => {
  const yml = maybe(root, id, 'target.yml')
  return yml !== null && field(yml, 'target') === name && field(yml, 'generator') === key
})?.id

function noSuite(db: Db, root: string, name: string, key: string): number | undefined {
  const plan = latest(db, root, name, key)
  if (plan === undefined) return undefined
  const last = refusalRows(db, plan)[0]
  return last?.step === 1 && last.span === 'bench.no_suite' ? plan : undefined
}

function regateable(db: Db, root: string, names: string[], key: string): void {
  for (const name of names) {
    const plan = latest(db, root, name, key)
    if (plan !== undefined && eventsOf(db, plan, 'bench.regrade').at(-1)?.outcome !== 'pass') {
      throw new Error(`${name}: plan ${String(plan)} has no clean regrade; run cf bench regrade ${String(plan)} or file with --why`)
    }
  }
}

/** The suites folder is the only copy left: the tick reaps `src/` from every done plan. */
export function scoredSuite(db: Db, root: string, id: number): { made: string; yml: string; target: string; generator: string; suites: string } {
  const plan = planById(db, id)
  if (plan.template !== 'bench' || plan.state !== 'done') throw new Error(`plan ${String(id)} is not a done bench plan`)
  const made = maybe(root, id, 'generate.json')
  if (made === null) throw new Error(`plan ${String(id)} has no generate.json`)
  const yml = get(root, id, 'target.yml')
  const [target, generator] = ['target', 'generator'].map((key) => field(yml, key))
  if (target === undefined || generator === undefined) throw new Error(`plan ${String(id)} has no target or generator in target.yml`)
  const suites = join(planDir(root, id), 'fuzz-bench/suites', generator, target)
  if (!existsSync(suites)) throw new Error(`plan ${String(id)} has no fuzz-bench/suites/${generator}/${target}`)
  return { made, yml, target, generator, suites }
}

export function rescore(db: Db, root: string, id: number, by: Holder, why: string): number | null {
  const { made, suites } = scoredSuite(db, root, id)
  const old = db.transaction(() => {
    const was = supersede(db, id)
    rewind(db, id, 2)
    logged(db, { plan: id, kind: 'rescore', actor: by, outcome: 'pass', message: why, pointer: was === null ? null : `bench_scorecard ${String(was)}`, run: null })
    return was
  })()
  const generated = JSON.parse(made) as { suite: string; wall?: string }
  put(root, id, 'generate.json', JSON.stringify({ ...generated, wall: undefined }))
  const suite = join(srcDir(root, id), generated.suite)
  rmSync(suite, { recursive: true, force: true })
  cpSync(suites, suite, { recursive: true })
  return old
}

export function refuzz(db: Db, root: string, source: number, hours: number, seeds: number, by: Holder, why: string, at: string): number {
  for (const [flag, n] of [['--hours', hours], ['--seeds', seeds]] as const) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} takes a positive whole number, not ${String(n)}`)
  }
  const { made, yml, target, generator, suites } = scoredSuite(db, root, source)
  const generated = JSON.parse(made) as { suite: string; wall?: string; partial?: string }
  const wall = generated.wall ?? generated.partial
  if (wall !== undefined) throw new Error(`plan ${String(source)} stopped at a wall: ${wall}`)
  if (!existsSync(join(suites, 'medusa.json'))) throw new Error(`plan ${String(source)} has no medusa.json in fuzz-bench/suites/${generator}/${target}`)
  const pipe = pipeNamed(db, 'refuzz')
  if (pipe === null) throw new Error('no pipe "refuzz"')
  const id = db.transaction(() => {
    const filed = addPlan(db, { pipe_id: pipe.id, target_id: null, template: 'bench', state: 'queued', queued_at: at, lane: null, seat: null, origin: null, step: 2 })
    briefed(db, filed, { title: `Bench: refuzz plan ${String(source)} (${generator} on ${target}), ${String(hours)} h × ${String(seeds)} seeds`, what: null, why: null, ends: null })
    logged(db, { plan: filed, kind: 'refuzz', actor: by, outcome: 'pass', message: why, pointer: `plan ${String(source)}`, run: null })
    return filed
  })()
  put(root, id, 'target.yml', `${yml.trimEnd()}\nmode: refuzz\nrefuzz: ${String(source)}\nhours: ${String(hours)}\nseeds: ${String(seeds)}\n`)
  put(root, id, 'generate.json', JSON.stringify({ ...generated, tokens: 0, seconds: 0 }))
  cpSync(suites, join(srcDir(root, id), generated.suite), { recursive: true })
  return id
}

export function medusaFile(db: Db, src: string, suite: string, workers: number, out: string): { clamped: string[]; compile: number } {
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`--workers takes a positive whole number, not ${String(workers)}`)
  const config = medusa(db, null, src, suite, null)
  if (config === null) throw new Error(`no medusa.json in ${src} or ${join(src, suite)}`)
  if ('outcome' in config) throw new Error(config.note)
  const compile = prebuilt(src, suite)
  Object.assign(config.config as object, { fuzzing: { ...(config.config as Config).fuzzing, workers }, compilation: reusing(config.config as Config) })
  const dir = mkdtempSync(join(tmpdir(), 'cf-medusa-'))
  try {
    rooted(src, dir)
    placed(config.config, src, dir)
    cpSync(join(dir, 'medusa.json'), out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { clamped: config.clamped, compile }
}

export function credit(db: Db, plan: number, runs: number[], why: string): void {
  if (planById(db, plan).template !== 'bench') throw new Error(`plan ${String(plan)} is not a bench plan`)
  const own = new Set(runTokens(db, plan).map(({ id }) => id))
  const stray = runs.find((run) => !own.has(run))
  if (stray !== undefined) throw new Error(`run ${String(stray)} is not a run of plan ${String(plan)}`)
  db.transaction(() => {
    for (const run of runs) logged(db, { plan, kind: 'bench.credit', actor: 'coo', outcome: 'pass', message: why, pointer: null, run })
  })()
}

export function profile(db: Db, root: string, id: number): string {
  if (planById(db, id).template !== 'bench') throw new Error(`plan ${String(id)} is not a bench plan`)
  const ran = lastTranscript(db, id, 1)
  const path = join(planDir(root, id), basename(ran))
  if (ran === '' || !existsSync(path)) throw new Error(`plan ${String(id)} has no generate transcript`)
  return profiled(path)
}

export function tokens(db: Db, root: string, plan: number, projects: string): string {
  const runs = generated(db, plan)
  if (runs.length === 0) throw new Error(`plan ${String(plan)} has no fizz generate run`)
  return runs.map((run) => render(run, split(join(planDir(root, plan), basename(run.transcript_path)), sessionDir(projects, run.session)))).join('')
}

function withMedusa(bench: Command, { db, out }: Cli): Command {
  bench.command('medusa').argument('<checkout>').requiredOption('--suite <dir>', 'the suite folder inside the checkout')
    .requiredOption('--workers <n>').requiredOption('--out <path>')
    .action((checkout: string, options: { suite: string; workers: string; out: string }) => {
      const { clamped, compile } = medusaFile(db(), checkout, options.suite, Number(options.workers), options.out)
      out(`medusa.json written to ${options.out}; compile_s: ${String(compile)}${clamped.length === 0 ? '' : `; targetContractsBalances ${clamped.join(', ')} clamped to 1e24 wei`}\n`)
    })
  return bench
}

export function registerBench(cf: Command, { root, db, out }: Cli): void {
  const bench = withMedusa(cf.command('bench'), { root, db, out })
  bench.command('file').argument('[target]').option('--all', 'one plan per targets/*.yml')
    .requiredOption('--generator <seat>', 'a bench generator key or seat in rules/staffing.yaml')
    .option('--stop-after <phase>', 'park a fizz_lean_generator run once this phase hands off')
    .option('--why <text>', 'file a fizz_lean_generator pair whose last run has no clean regrade')
    .action((target: string | undefined, options: { all?: boolean; generator: string; stopAfter?: string; why?: string }) => {
      for (const id of fileBench(db(), root, target, options.all === true, options.generator, new Date().toISOString(), options.stopAfter, options.why)) {
        out(`plan ${String(id)}\t${[...get(root, id, 'target.yml').matchAll(/^target: (.*)$/gm)].at(-1)?.[1] ?? ''}\n`)
      }
    })
  bench.command('rescore').argument('<plans...>').requiredOption('--by <who>', 'ceo or coo').requiredOption('--why <text>')
    .action((plans: string[], options: { by: string; why: string }) => {
      const by = holderOf(options.by)
      for (const id of plans.map(Number)) {
        const old = rescore(db(), root, id, by, options.why)
        out(`plan ${String(id)} queued at step 2, supersedes scorecard ${old === null ? 'none' : String(old)}\n`)
      }
    })
  bench.command('refuzz').argument('<plan>').requiredOption('--hours <n>').requiredOption('--seeds <k>')
    .requiredOption('--by <who>', 'ceo or coo').requiredOption('--why <text>')
    .action((plan: string, options: { hours: string; seeds: string; by: string; why: string }) => {
      const id = refuzz(db(), root, Number(plan), Number(options.hours), Number(options.seeds), holderOf(options.by), options.why, new Date().toISOString())
      out(`plan ${String(id)} queued at step 2 on the refuzz pipe\n`)
    })
  bench.command('credit').argument('<plan>').argument('<runs...>').requiredOption('--why <text>')
    .action((plan: string, runs: string[], options: { why: string }) => {
      credit(db(), Number(plan), runs.map(Number), options.why)
      for (const run of runs) out(`run ${run} credited to plan ${plan}\n`)
    })
  bench.command('profile').argument('<plan>')
    .action((plan: string) => { out(profile(db(), root, Number(plan))) })
  bench.command('tokens').argument('<plan>')
    .action((plan: string) => { out(tokens(db(), root, Number(plan), join(homedir(), '.claude/projects'))) })
  bench.command('dry').argument('<plan>').option('--suite <plan>', 'a done bench plan whose suite replaces test/fizz')
    .action((plan: string, options: { suite?: string }) => {
      out(dried(db(), root, Number(plan), join(homedir(), '.claude/skills/fizz'), options.suite === undefined ? undefined : Number(options.suite)))
    })
  bench.command('regrade').argument('<plan>').action((plan: string) => { out(regraded(db(), root, Number(plan), join(homedir(), '.claude/skills/fizz'))) })
}
