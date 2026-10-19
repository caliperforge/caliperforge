import type { Command } from 'commander'
import { z } from 'zod'
import { ofKind } from '../store/events.ts'
import { homes } from '../store/homes.ts'
import type { Db } from '../store/index.ts'
import { LANES, laneOf } from '../store/lanes.ts'
import { allPlans, clearWaitsOn, held, originRef, planRows } from '../store/plans.ts'
import type { Cli } from './cf-lanes.ts'
import { fileIssue, gh, run, type Read, type Run } from './gh.ts'

const FROM = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/
const TO = /^[^/#\s]+\/[^/#\s]+$/
const PRIORITY = /^P[0-9]$/

function carried(labels: { name: string }[], to: string): string[] {
  const was = laneOf(labels)
  const lane = was !== null && homes(was).includes(to) ? was : LANES.find((l) => homes(l).includes(to)) ?? was
  return [...(lane === null ? [] : [`lane:${lane}`]), ...labels.map((l) => l.name).filter((n) => PRIORITY.test(n))]
}

export function refile(db: Db, from: string, to: string, read: Read = gh, exec: Run = run): string {
  const hit = FROM.exec(from)
  if (hit === null || !TO.test(to)) throw new Error(`cf gh refile takes <owner/name#n> <owner/name>, not ${from} ${to}`)
  const repo = String(hit[1])
  const no = Number(hit[2])
  const plan = allPlans(db).find((p) => originRef(p)?.repo === repo && originRef(p)?.no === no)
  if (plan === undefined) throw new Error(`no plan's origin is ${repo}#${String(no)}`)
  const block = ofKind(db, 'director', 'coo_lite').filter((e) => e.plan === plan.id).at(-1)
  const { title, body, labels } = z.object({ title: z.string(), body: z.string(), labels: z.array(z.object({ name: z.string() })) })
    .parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'title,body,labels']))
  const moved = block === undefined ? body : `${body}\n\n## Why it moved\n\n${block.message}`
  const url = fileIssue(to, title, moved, carried(labels, to), exec)
  exec(['issue', 'close', String(no), '--repo', repo, '--comment', `Moved to ${url}`])
  for (const r of planRows(db).filter((p) => p.waits_on === plan.id && p.state === 'blocked_on_ceo')) {
    clearWaitsOn(db, Number(r.id))
    held(db, Number(r.id), 'coo', `waits on ${url}`)
  }
  return url
}

export function registerRefile(cf: Command, { db, out }: Cli): void {
  cf.command('gh').command('refile').argument('<from>').argument('<to>')
    .action((from: string, to: string) => { out(`${refile(db(), from, to)}\n`) })
}
