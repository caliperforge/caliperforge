import type { Command } from 'commander'
import { push } from '../sequencer/site.ts'
import type { Cli } from './cf-lanes.ts'

export function registerSite(cf: Command, { db, out }: Cli): void {
  cf.command('site').command('push').requiredOption('--by <actor>', 'who ran it: ceo').action((options: { by: string }) => {
    if (options.by !== 'ceo') throw new Error(`site push takes --by ceo, not ${options.by}`)
    out(`${String(push(db(), new Date()))} post(s) published\n`)
  })
}
