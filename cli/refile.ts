import type { Command } from 'commander'
import { z } from 'zod'
import { ofKind } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { allPlans, originRef } from '../store/plans.ts'
import type { Cli } from './cf-lanes.ts'
import { gh, run, type Read, type Run } from './gh.ts'

const FROM = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/
const TO = /^[^/#\s]+\/[^/#\s]+$/

export function refile(db: Db, from: string, to: string, read: Read = gh, exec: Run = run): string {
  const hit = FROM.exec(from)
  if (hit === null || !TO.test(to)) throw new Error(`cf gh refile takes <owner/name#n> <owner/name>, not ${from} ${to}`)
  const repo = String(hit[1])
  const no = Number(hit[2])
  const plan = allPlans(db).find((p) => originRef(p)?.repo === repo && originRef(p)?.no === no)
  if (plan === undefined) throw new Error(`no plan's origin is ${repo}#${String(no)}`)
  const block = ofKind(db, 'director', 'coo_lite').filter((e) => e.plan === plan.id).at(-1)
  if (block === undefined) throw new Error(`plan ${String(plan.id)} has no coo_lite event`)
  const { title } = z.object({ title: z.string() }).parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'title']))
  const url = exec(['issue', 'create', '--repo', to, '--title', title, '--body-file', '-'], block.message).trim()
  exec(['issue', 'close', String(no), '--repo', repo, '--comment', `Moved to ${url}`])
  return url
}

export function registerRefile(cf: Command, { db, out }: Cli): void {
  cf.command('gh').command('refile').argument('<from>').argument('<to>')
    .action((from: string, to: string) => { out(`${refile(db(), from, to)}\n`) })
}
