import type { Command } from 'commander'
import { adopt, render as renderAdopt } from './adopt.ts'
import { approve as approveCard, batch, landed, refuse as refuseCard, render, renderLanded } from './batch.ts'
import type { Cli } from './cf-lanes.ts'
import { measure, render as renderPulse } from './measure.ts'
import { approve as approveTarget, refuseTarget } from './queue.ts'
import { fill as fillRecord, render as renderRecord, still } from './record.ts'
import { render as renderScan, scan } from './scan.ts'

export function registerTargets(cf: Command, { db, out }: Cli): void {
  cf.command('measure').argument('<repo>', 'owner/repo to take the step 0 pulse of').action((repo: string) => {
    out(renderPulse(measure(db(), repo, new Date().toISOString().slice(0, 10))))
  })

  cf.command('record').argument('<repo>', 'owner/repo whose pull requests of ours to record').action((repo: string) => {
    const handle = db()
    out(renderRecord(repo, fillRecord(handle, repo), still(handle, repo)))
  })

  cf.command('scan').argument('<repo>', 'owner/repo whose open issues to write as ready targets').action((repo: string) => {
    const handle = db()
    fillRecord(handle, repo)
    const { targets, why } = scan(handle, repo, new Date().toISOString().slice(0, 10))
    if (why !== null) {
      process.stderr.write(`cf: ${why}\n`)
      process.exitCode = 1
      return
    }
    for (const id of targets) out(renderScan(handle, id))
  })
}

export function registerApprovals(cf: Command, { root, db, out }: Cli): void {
  const approve = cf.command('approve')

  const refuse = cf.command('refuse')

  approve.command('target').argument('<id>').option('--pipe <name>', 'pipe to file its plan on', 'pr-path')
    .action((id: string, options: { pipe: string }) => {
      const done = approveTarget(db(), root, Number(id), options.pipe)
      out(`target ${id} approved\t${done.digest.slice(0, 12)}\tplan ${done.plan === null ? '-' : String(done.plan)}\n`)
    })

  refuse.command('target').argument('<id>').argument('<reason>').action((id: string, reason: string) => {
    out(`target ${id} refused\t${refuseTarget(db(), Number(id), reason).slice(0, 12)}\n`)
  })

  cf.command('batch').action(() => {
    const handle = db()
    const cards = batch(handle, root)
    if (cards.length === 0) out('nothing awaiting sign-off\n')
    for (const card of cards) out(render(card))
    for (const row of landed(handle)) out(renderLanded(row))
  })

  for (const kind of ['plan', 'proposal'] as const) {
    approve.command(kind).argument('<id>').action((id: string) => {
      out(`${kind} ${id} approved\t${approveCard(db(), root, kind, Number(id)).slice(0, 12)}\n`)
    })
    refuse.command(kind).argument('<id>').argument('<reason>').action((id: string, reason: string) => {
      out(`${kind} ${id} refused\t${refuseCard(db(), root, kind, Number(id), reason).slice(0, 12)}\n`)
    })
  }
}

export function registerAdopt(cf: Command, { root, db, out }: Cli): void {
  cf.command('adopt').argument('<ref>', 'an <owner/repo>#<n> pull request of ours that is already open')
    .action((ref: string) => {
      out(renderAdopt(adopt(db(), root, ref, new Date().toISOString().slice(0, 10))))
    })
}
