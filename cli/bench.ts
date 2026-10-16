import type { Command } from 'commander'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { staffing } from '../sequencer/staffing.ts'
import { get, git, gitBase, put, remote } from '../sequencer/workspace.ts'
import type { Db } from '../store/index.ts'
import { addPlan, pipeNamed } from '../store/plans.ts'
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
      put(root, id, 'target.yml', `${readFileSync(join(targets, `${name}.yml`), 'utf8').trimEnd()}\ntarget: ${name}\ngenerator: ${key}\n`)
      return id
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function registerBench(cf: Command, { root, db, out }: Cli): void {
  cf.command('bench').command('file').argument('[target]').option('--all', 'one plan per targets/*.yml')
    .requiredOption('--generator <seat>', 'a bench generator in rules/staffing.yaml')
    .action((target: string | undefined, options: { all?: boolean; generator: string }) => {
      for (const id of fileBench(db(), root, target, options.all === true, options.generator, new Date().toISOString())) {
        out(`plan ${String(id)}\t${[...get(root, id, 'target.yml').matchAll(/^target: (.*)$/gm)].at(-1)?.[1] ?? ''}\n`)
      }
    })
}
