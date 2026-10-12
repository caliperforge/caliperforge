import type { Command } from 'commander'
import { lookup } from 'node:dns/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { live, providers } from '../paydesk/live.ts'
import { prs } from '../paydesk/prs.ts'
import { scan, type Net } from '../paydesk/scan.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPaydesk(cf: Command, { root, out }: Cli): void {
  const net: Net = { fetch, resolve: (host) => lookup(host) }
  const paydesk = cf.command('paydesk')
  paydesk.command('scan').argument('<dir...>').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (dirs: string[], options: { out: string; cards?: string }) => {
      const results = await scan(dirs, options.out, options.cards, net)
      const crashed = results.filter((r) => 'crash' in r).length
      out(`${String(results.length)} listings, ${String(crashed)} crashed -> ${options.out}\n`)
    })
  paydesk.command('prs').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (options: { out: string; cards?: string }) => {
      const ran = await prs(root, options.out, options.cards, net)
      const crashed = ran.listings.filter((r) => 'crash' in r).length
      out(`${String(ran.prs)} PRs, ${String(ran.listings.length)} listings, ${String(crashed)} crashed, ${String(ran.skipped.length)} skipped -> ${options.out}\n`)
    })
  paydesk.command('live').action(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pay-skills-'))
    try {
      const dir = join(root, '.cf/paydesk')
      const date = new Date().toISOString().slice(0, 10)
      const { failing, passing, gone } = await live(dir, date, providers(tmp), net)
      out(`${String(failing.length)} newly failing, ${String(passing.length)} newly passing, ${String(gone.length)} gone -> ${join(dir, `live-${date}.md`)}\n`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}
