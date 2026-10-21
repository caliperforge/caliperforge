import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { real } from '../runner/index.ts'
import { planById } from '../store/plans.ts'
import { drafted } from '../templates/research.ts'
import type { Cli } from './cf-lanes.ts'

export function planOf(root: string, cwd: string): number {
  const first = relative(real(join(root, '.cf/work')), real(cwd)).split(sep)[0] ?? ''
  if (!/^\d+$/.test(first)) throw new Error("cf research check runs from a plan's checkout")
  return Number(first)
}

export function registerResearch(cf: Command, { root, db, out }: Cli): void {
  cf.command('research').command('check').argument('<draft>').action(async (draft: string) => {
    const cwd = process.cwd()
    const got = await drafted(root, planById(db(), planOf(root, cwd)), readFileSync(resolve(cwd, draft), 'utf8'))
    out(got.outcome === 'pass' ? `pass\t${got.note}\n` : `refuse\t${got.spans.join(', ')}\t${got.note}\n`)
    if (got.outcome !== 'pass') process.exitCode = 1
  })
}
