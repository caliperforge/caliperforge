import type { Command } from 'commander'
import { drained } from '../precedents/distill.ts'
import { counted } from '../precedents/escapes.ts'
import { harvest } from '../precedents/harvest.ts'
import { precedentsFor, row } from '../precedents/lookup.ts'
import { mismatches } from '../precedents/mismatch.ts'
import { type Listed, openings } from '../precedents/openings.ts'
import { parity } from '../precedents/parity.ts'
import { started } from '../precedents/surfpool.ts'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import type { Provider } from '../providers/kind.ts'
import { escapesOf } from '../store/escapes.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, type Read } from './gh.ts'

export function registerPrecedents(cf: Command, { root, db, out }: Cli, provider: Provider = claudeAgentSdk, read: Read = gh,
  surfpool: { start: typeof started; gap: number } = { start: started, gap: 1000 }): void {
  const precedents = cf.command('precedents')
  precedents.command('harvest').argument('<repo>').option('--since <date>', 'harvest PRs merged after this date')
    .action((repo: string, options: { since?: string }) => { out(`${repo}\t${String(harvest(db(), repo, options.since ?? null))} stored\n`) })
  precedents.command('distill').argument('<repo>').action(async (repo: string) => {
    const { prs, rows } = await drained(db(), root, repo, provider)
    out(`${repo}\t${String(prs)} distilled, ${String(rows)} stored\n`)
  })
  precedents.command('escapes').argument('<repo>').action((repo: string) => {
    for (const { number, escapes } of counted(db(), root, repo)) {
      out(`${repo}#${String(number)}\t${String(escapes)}\n`)
      for (const e of escapesOf(db(), repo, number)) out(`  ${e.area}:${String(e.line)}\t${e.url}\n`)
    }
  })
  precedents.command('for').argument('<repo>').argument('<files...>').action((repo: string, files: string[]) => {
    for (const p of precedentsFor(db(), repo, files, read)) out(`${row(p)}\n`)
  })
  const line = (o: Listed): string => `${o.first_seen}\t${o.repo}\t${o.kind}\t${o.area}\t${o.said_by}\t${o.source}\t${o.quote}\n`
  const opens = cf.command('openings').argument('[repo]').action((repo: string | undefined) => {
    for (const o of openings(db(), repo ?? null)) out(line(o))
  })
  opens.command('parity').argument('<repo>').action(async (repo: string) => {
    await parity(db(), root, repo, provider, read)
    for (const o of openings(db(), repo).filter((r) => r.kind === 'drift')) out(line(o))
  })
  cf.command('parity').argument('<checkout>').option('--rpc <url>', 'mainnet RPC to compare and fork', 'https://api.mainnet-beta.solana.com')
    .action(async (checkout: string, options: { rpc: string }) => {
      const fork = await surfpool.start(checkout, options.rpc)
      try {
        const run = await mismatches(db(), checkout, { mainnet: options.rpc, surfpool: fork.url }, read, surfpool.gap)
        out(`solana-foundation/surfpool\t${String(run.filed)} filed, ${String(run.flaky)} flaky, ${String(run.claimed)} claimed\n`)
        for (const method of run.disabled) out(`${method}\tmainnet-disabled\n`)
        for (const o of openings(db(), 'solana-foundation/surfpool').filter((r) => r.said_by === 'parity_compare')) out(line(o))
      } finally { fork.stop() }
    })
}
