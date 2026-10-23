import type { Command } from 'commander'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staffing } from '../sequencer/staffing.ts'
import { get, git, gitBase, maybe, planDir, put, remote, srcDir } from '../sequencer/workspace.ts'
import { supersede } from '../store/bench.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { addPlan, briefed, holderOf, pipeNamed, planById, rewind, type Holder } from '../store/plans.ts'
import { copied } from '../templates/bench.ts'
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
export function rescore(db: Db, root: string, id: number, by: Holder, why: string): number | null {
  const plan = planById(db, id)
  if (plan.template !== 'bench' || plan.state !== 'done') throw new Error(`plan ${String(id)} is not a done bench plan`)
  const made = maybe(root, id, 'generate.json')
  if (made === null) throw new Error(`plan ${String(id)} has no generate.json`)
  const yml = get(root, id, 'target.yml')
  const [target, generator] = ['target', 'generator'].map((key) => [...yml.matchAll(new RegExp(`^${key}: (.+)$`, 'gm'))].at(-1)?.[1])
  if (target === undefined || generator === undefined) throw new Error(`plan ${String(id)} has no target or generator in target.yml`)
  const suites = join(planDir(root, id), 'fuzz-bench/suites', generator, target)
  if (!existsSync(suites)) throw new Error(`plan ${String(id)} has no fuzz-bench/suites/${generator}/${target}`)
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
}
