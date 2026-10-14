import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setting } from '../store/drift.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { hhmm, zone } from '../store/lanes.ts'
import { addPlan, briefed, openPipes, titles } from '../store/plans.ts'
import { put } from './workspace.ts'

/** One account plan per `accounts/<slug>.md`, filed once per local date on Monday from 06:30 while `accounts.weekly` is on. */
export function accounts(db: Db, root: string, now: Date): void {
  const local = new Date(now.getTime() + zone(db) * 60000)
  if (local.getUTCDay() !== 1 || hhmm(db, now) < '06:30' || setting(db, 'accounts.weekly') !== '1') return
  const pipe = openPipes(db, '06:30')[0]
  if (pipe === undefined) return
  const day = local.toISOString().slice(0, 10)
  const filed = titles(db, 'account')
  const slugs = readdirSync(join(root, 'accounts')).filter((n) => n.endsWith('.md') && n !== 'README.md').map((n) => n.slice(0, -3))
  for (const slug of slugs) {
    const title = `account ${slug} ${day}`
    if (filed.includes(title)) continue
    const plan = addPlan(db, { pipe_id: pipe.id, target_id: null, template: 'account', state: 'queued', queued_at: now.toISOString(),
      lane: null, seat: null, origin: null, step: 0 })
    briefed(db, plan, { title, what: null, why: null, ends: null })
    put(root, plan, 'ask.md', `# ${title}\n\n**Account:** ${slug}\n`)
    logged(db, { plan, kind: 'filed', actor: 'account clock', outcome: 'pass', message: slug, pointer: null, run: null })
  }
}
