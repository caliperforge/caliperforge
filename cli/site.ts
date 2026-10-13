import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { push } from '../sequencer/site.ts'
import { get, set } from '../store/lanes.ts'
import type { Cli } from './cf-lanes.ts'

export function registerSite(cf: Command, { db, out }: Cli): void {
  const site = cf.command('site')
  site.command('push').requiredOption('--by <actor>', 'who ran it: ceo').action((options: { by: string }) => {
    if (options.by !== 'ceo') throw new Error(`site push takes --by ceo, not ${options.by}`)
    out(`${String(push(db(), new Date()))} post(s) published\n`)
  })
  site.command('dir <path>').requiredOption('--by <actor>', 'who ran it: ceo').action((path: string, options: { by: string }) => {
    if (options.by !== 'ceo') throw new Error(`site dir takes --by ceo, not ${options.by}`)
    const dir = path.replace(/^~(?=\/|$)/, homedir())
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${path} is not a directory`)
    if (!existsSync(join(dir, '.git'))) throw new Error(`${path} has no .git`)
    const old = get(db(), 'comms.site_dir')
    set(db(), 'comms.site_dir', path, 'ceo', new Date().toISOString())
    out(`comms.site_dir ${JSON.stringify(old)} → ${JSON.stringify(path)}\n`)
  })
}
