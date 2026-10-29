import type { Command } from 'commander'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { staffing } from '../sequencer/staffing.ts'
import { render, sessionDir, split } from '../sequencer/subagents.ts'
import { get, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { supersede } from '../store/bench.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { addPlan, briefed, holderOf, pipeNamed, planById, rewind, type Holder } from '../store/plans.ts'
import { generated, lastTranscript } from '../store/runs.ts'
import { copied } from '../templates/bench.ts'
import { profiled } from '../templates/profile.ts'
import type { Cli } from './cf-lanes.ts'

export function fileBench(db: Db, root: string, target: string | undefined, all: boolean, seat: string, at: string): number[] {
  const key = staffing(root).find((r) => r.template === 'bench' && r.step === 1 && r.seat === seat)?.key
  if (key === undefined) throw new Error(`${seat} is not a bench generator in rules/staffing.yaml`)
  if (all === (target !== undefined)) throw new Error('cf bench file takes <target> or --all')
  const pipe = pipeNamed(db, 'bench')
  if (pipe === null) throw new Error('no pipe "bench"')
  const dir = mkdtempSync(join(tmpdir(), 'cf-fuzz-bench-'))
  try {
    git(dir, ['clone', '-q', remote(gitBase(root), 'caliperforge/fuzz-bench'), 'fuzz-bench'])
    const targets = join(dir, 'fuzz-bench/targets')
    const names = target !== undefined ? [target] : readdirSync(targets).filter((f) => f.endsWith('.yml')).sort().map((f) => f.slice(0, -4))
    const missing = names.find((name) => !existsSync(join(targets, `${name}.yml`)))
    if (missing !== undefined) throw new Error(`fuzz-bench has no targets/${missing}.yml`)
    return names.map((name) => {
      const id = addPlan(db, { pipe_id: pipe.id, target_id: null, template: 'bench', state: 'queued', queued_at: at, lane: null, seat: null, origin: null, step: 0 })
      briefed(db, id, { title: `Bench: score ${key} on ${name} (catch / miss / false alarm)`, what: null, why: null, ends: null })
      put(root, id, 'target.yml', copied(readFileSync(join(targets, `${name}.yml`), 'utf8'), name, key))
      return id
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The suites folder is the only copy left: the tick reaps `src/` from every done plan. */
function scoredSuite(db: Db, root: string, id: number): { made: string; yml: string; target: string; generator: string; suites: string } {
  const plan = planById(db, id)
  if (plan.template !== 'bench' || plan.state !== 'done') throw new Error(`plan ${String(id)} is not a done bench plan`)
  const made = maybe(root, id, 'generate.json')
  if (made === null) throw new Error(`plan ${String(id)} has no generate.json`)
  const yml = get(root, id, 'target.yml')
  const [target, generator] = ['target', 'generator'].map((key) => [...yml.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))].at(-1)?.[1])
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
  const suite = join(srcDir(root, id), (JSON.parse(made) as { suite: string }).suite)
  rmSync(suite, { recursive: true, force: true })
  cpSync(suites, suite, { recursive: true })
  return old
}

export function refuzz(db: Db, root: string, source: number, hours: number, seeds: number, by: Holder, why: string, at: string): number {
  for (const [flag, n] of [['--hours', hours], ['--seeds', seeds]] as const) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} takes a positive whole number, not ${String(n)}`)
  }
  const { made, yml, target, generator, suites } = scoredSuite(db, root, source)
  const generated = JSON.parse(made) as { suite: string; wall?: string }
  if (generated.wall !== undefined) throw new Error(`plan ${String(source)} stopped at a wall: ${generated.wall}`)
  if (!existsSync(join(suites, 'medusa.json'))) throw new Error(`plan ${String(source)} has no medusa.json in fuzz-bench/suites/${generator}/${target}`)
  const pipe = pipeNamed(db, 'refuzz')
  if (pipe === null) throw new Error('no pipe "refuzz"')
  const id = db.transaction(() => {
    const filed = addPlan(db, { pipe_id: pipe.id, target_id: null, template: 'bench', state: 'queued', queued_at: at, lane: null, seat: null, origin: null, step: 2 })
    briefed(db, filed, { title: `Bench: refuzz plan ${String(source)} (${generator} on ${target}), ${String(hours)} h × ${String(seeds)} seeds`, what: null, why: null, ends: null })
    logged(db, { plan: filed, kind: 'refuzz', actor: by, outcome: 'pass', message: why, pointer: `plan ${String(source)}`, run: null })
    return filed
  })()
  put(root, id, 'target.yml', `${yml.trimEnd()}\nrefuzz: ${String(source)}\nhours: ${String(hours)}\nseeds: ${String(seeds)}\n`)
  put(root, id, 'generate.json', JSON.stringify({ ...generated, tokens: 0, seconds: 0 }))
  cpSync(suites, join(srcDir(root, id), generated.suite), { recursive: true })
  return id
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

export function registerBench(cf: Command, { root, db, out }: Cli): void {
  const bench = cf.command('bench')
  bench.command('file').argument('[target]').option('--all', 'one plan per targets/*.yml')
    .requiredOption('--generator <seat>', 'a bench generator in rules/staffing.yaml')
    .action((target: string | undefined, options: { all?: boolean; generator: string }) => {
      for (const id of fileBench(db(), root, target, options.all === true, options.generator, new Date().toISOString())) {
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
  bench.command('profile').argument('<plan>')
    .action((plan: string) => { out(profile(db(), root, Number(plan))) })
  bench.command('tokens').argument('<plan>')
    .action((plan: string) => { out(tokens(db(), root, Number(plan), join(homedir(), '.claude/projects'))) })
}
