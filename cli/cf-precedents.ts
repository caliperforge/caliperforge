import type { Command } from 'commander'
import { drained } from '../precedents/distill.ts'
import { harvest } from '../precedents/harvest.ts'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import type { Provider } from '../providers/kind.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPrecedents(cf: Command, { root, db, out }: Cli, provider: Provider = claudeAgentSdk): void {
  const precedents = cf.command('precedents')
  precedents.command('harvest').argument('<repo>').option('--since <date>', 'harvest PRs merged after this date')
    .action((repo: string, options: { since?: string }) => { out(`${repo}\t${String(harvest(db(), repo, options.since ?? null))} stored\n`) })
  precedents.command('distill').argument('<repo>').action(async (repo: string) => {
    const { prs, rows } = await drained(db(), root, repo, provider)
    out(`${repo}\t${String(prs)} distilled, ${String(rows)} stored\n`)
  })
}
