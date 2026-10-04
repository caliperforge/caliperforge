import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { amend, approved, opened, postOf, sentBack } from '../store/desk.ts'
import type { Db } from '../store/index.ts'
import { holder } from '../store/leases.ts'
import { holderOf, HOLDERS, requeue, type Holder } from '../store/plans.ts'
import { steps } from '../templates/comms.ts'
import type { Cli } from './cf-lanes.ts'

const BY = ['--by <actor>', `who ran it: ${HOLDERS.join(' or ')}`] as const
const DRAFT = steps.findIndex((s) => s.name === 'draft')
const FIELDS = ['title', 'dek', 'body'] as const

export function giveBack(db: Db, id: number, note: string, by: Holder): void {
  if (holder(db, id) !== null) throw new Error(`plan ${String(id)} is mid-step in a live tick; return it once the tick lets go`)
  db.transaction(() => {
    sentBack(db, id, note, by)
    requeue(db, id, DRAFT)
  })()
}

export function registerDesk(cf: Command, { db, out }: Cli): void {
  const desk = cf.command('desk')

  desk.command('list').action(() => {
    for (const p of opened(db())) out(`${String(p.id)}\t${p.kind}\t${p.dest}\t${p.status}\t${p.title}\n`)
  })

  desk.command('show').argument('<id>').action((id: string) => {
    const p = postOf(db(), Number(id))
    out(`${String(p.id)}\t${p.kind}\t${p.dest}\t${p.status}\n\n${p.edited_title ?? p.title}\n\n${p.edited_dek ?? p.dek}\n\n${p.edited_body ?? p.body}\n`
      + (p.note === null ? '' : `\nnote: ${p.note}\n`))
  })

  desk.command('edit').argument('<id>').option('--title <file>', 'the new title')
    .option('--dek <file>', 'the new dek').option('--body <file>', 'the new body').requiredOption(...BY)
    .action((id: string, options: Partial<Record<typeof FIELDS[number], string>> & { by: string }) => {
      const by = holderOf(options.by)
      const fields = Object.fromEntries(FIELDS.flatMap((f) => options[f] === undefined ? [] : [[f, readFileSync(options[f], 'utf8')]]))
      if (Object.keys(fields).length === 0) throw new Error('desk edit takes --title, --dek or --body')
      amend(db(), Number(id), fields, by)
      out(`desk post ${id} edited\n`)
    })

  desk.command('approve').argument('<id>').requiredOption(...BY).action((id: string, options: { by: string }) => {
    const by = holderOf(options.by)
    approved(db(), Number(id), by)
    out(`desk post ${id} approved\n`)
  })

  desk.command('return').argument('<id>').requiredOption('--note <text>', 'what the writer changes').requiredOption(...BY)
    .action((id: string, options: { note: string; by: string }) => {
      const by = holderOf(options.by)
      giveBack(db(), Number(id), options.note, by)
      out(`desk post ${id} returned; plan ${id} queued at step ${String(DRAFT)}\n`)
    })
}
