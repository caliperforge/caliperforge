import type { Command } from 'commander'
import { lookup } from 'node:dns/promises'
import { prs } from '../paydesk/prs.ts'
import { scan } from '../paydesk/scan.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPaydesk(cf: Command, { root, out }: Cli): void {
  const paydesk = cf.command('paydesk')
  paydesk.command('scan').argument('<dir...>').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (dirs: string[], options: { out: string; cards?: string }) => {
      const results = await scan(dirs, options.out, options.cards, { fetch, resolve: (host) => lookup(host) })
      const crashed = results.filter((r) => 'crash' in r).length
      out(`${String(results.length)} listings, ${String(crashed)} crashed -> ${options.out}\n`)
    })
  paydesk.command('prs').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (options: { out: string; cards?: string }) => {
      const ran = await prs(root, options.out, options.cards, { fetch, resolve: (host) => lookup(host) })
      const crashed = ran.listings.filter((r) => 'crash' in r).length
      out(`${String(ran.prs)} PRs, ${String(ran.listings.length)} listings, ${String(crashed)} crashed, ${String(ran.skipped.length)} skipped -> ${options.out}\n`)
    })
}
