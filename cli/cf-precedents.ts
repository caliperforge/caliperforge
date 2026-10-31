import type { Command } from 'commander'
import { harvest } from '../precedents/harvest.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPrecedents(cf: Command, { db, out }: Cli): void {
  cf.command('precedents').command('harvest').argument('<repo>').option('--since <date>', 'harvest PRs merged after this date')
    .action((repo: string, options: { since?: string }) => { out(`${repo}\t${String(harvest(db(), repo, options.since ?? null))} stored\n`) })
}
