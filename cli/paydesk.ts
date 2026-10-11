import type { Command } from 'commander'
import { lookup } from 'node:dns/promises'
import { scan } from '../paydesk/scan.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPaydesk(cf: Command, { out }: Cli): void {
  cf.command('paydesk').command('scan').argument('<dir...>').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (dirs: string[], options: { out: string; cards?: string }) => {
      const results = await scan(dirs, options.out, options.cards, { fetch, resolve: (host) => lookup(host) })
      const crashed = results.filter((r) => 'crash' in r).length
      out(`${String(results.length)} listings, ${String(crashed)} crashed -> ${options.out}\n`)
    })
}
