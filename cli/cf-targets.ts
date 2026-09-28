import type { Command } from 'commander'
import { adopt, render as renderAdopt } from './adopt.ts'
import { approve as approveCard, batch, landed, refuse as refuseCard, render, renderLanded } from './batch.ts'
import type { Cli } from './cf-lanes.ts'
import { measure, render as renderPulse } from './measure.ts'
import { approve as approveTarget, refuseTarget } from './queue.ts'
import { fill as fillRecord, render as renderRecord, still } from './record.ts'
import { render as renderScan, scan } from './scan.ts'
import { approve as approvePublish, refuse as refusePublish } from '../sequencer/card.ts'
import { HOLDERS, holderOf } from '../store/plans.ts'

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

  signoffs(approve, refuse, { root, db, out })
}

function signoffs(approve: Command, refuse: Command, { root, db, out }: Cli): void {
  const BY = ['--by <holder>', `who signs it: ${HOLDERS.join(' or ')}`] as const

  approve.command('plan').argument('<id>').requiredOption(...BY).action((id: string, options: { by: string }) => {
    const by = holderOf(options.by)
    out(`plan ${id} approved\t${approveCard(db(), root, 'plan', Number(id), by).slice(0, 12)}\n`)
  })
  refuse.command('plan').argument('<id>').argument('<reason>').requiredOption(...BY)
    .action((id: string, reason: string, options: { by: string }) => {
      const by = holderOf(options.by)
      out(`plan ${id} refused\t${refuseCard(db(), root, 'plan', Number(id), reason, by).slice(0, 12)}\n`)
    })

  approve.command('proposal').argument('<id>').action((id: string) => {
    out(`proposal ${id} approved\t${approveCard(db(), root, 'proposal', Number(id), 'ceo').slice(0, 12)}\n`)
  })
  refuse.command('proposal').argument('<id>').argument('<reason>').action((id: string, reason: string) => {
    out(`proposal ${id} refused\t${refuseCard(db(), root, 'proposal', Number(id), reason, 'ceo').slice(0, 12)}\n`)
  })

  approve.command('card').argument('<plan>').requiredOption(...BY).action((plan: string, options: { by: string }) => {
    const by = holderOf(options.by)
    out(`card ${plan} approved\t${approvePublish(db(), root, Number(plan), by).slice(0, 12)}\n`)
  })
  refuse.command('card').argument('<plan>').argument('<reason>').requiredOption(...BY)
    .action((plan: string, reason: string, options: { by: string }) => {
      const by = holderOf(options.by)
      out(`card ${plan} refused\t${refusePublish(db(), root, Number(plan), reason, by).slice(0, 12)}\n`)
    })
}

export function registerAdopt(cf: Command, { root, db, out }: Cli): void {
  cf.command('adopt').argument('<ref>', 'an <owner/repo>#<n> pull request of ours that is already open')
    .action((ref: string) => {
      out(renderAdopt(adopt(db(), root, ref, new Date().toISOString().slice(0, 10))))
    })
}
