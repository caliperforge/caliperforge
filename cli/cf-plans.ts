import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { hold, unhold } from '../sequencer/hold.ts'
import { afresh, reap } from '../sequencer/workspace.ts'
import { blocked, parked, WAITING } from '../sequencer/steps.ts'
import { release, retried } from '../store/holds.ts'
import { hhmm, lanes } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { PlanRow, terminal } from '../store/plans.ts'
import { laneLine, open as openPlans, runsOf, section, verdictsOf } from './brief.ts'
import type { Cli } from './cf-lanes.ts'
import { add as fileIssue, render as renderUnfiled, unfiled } from './plan.ts'
import { add, note } from './queue.ts'

export function registerPlans(cf: Command, cli: Cli): void {
  queues(cf, cli)
  shown(planned(cf, cli), cli)
  holds(cf, cli)
}

function queues(cf: Command, { root, db, out }: Cli): void {
  const queue = cf.command('queue')

  queue.command('add').argument('<repo>').argument('<issue-url>').option('--pipe <name>', 'pipe to queue on', 'pr-path')
    .option('--part <slug>', 'one item of the issue: its own target, plan and branch; needs --ask')
    .option('--ask <file>', 'our target card: the job is this, their issue only its context')
    .option('--pr <file>', 'the body the pull request opens with')
    .action((repo: string, url: string, options: { pipe: string; ask?: string; pr?: string; part?: string }) => {
      const scope = {
        ...(options.part === undefined ? {} : { part: options.part }),
        ...(options.ask === undefined ? {} : { card: readFileSync(options.ask, 'utf8') }),
        ...(options.pr === undefined ? {} : { pr: readFileSync(options.pr, 'utf8') }),
      }
      const added = add(db(), root, repo, url, options.pipe, new Date().toISOString().slice(0, 10), scope)
      const origin = added.origin === null ? '-' : `${added.origin.origin_kind}:${added.origin.origin_ref}`
      out(`target ${String(added.target)} ${added.state}\tplan ${added.plan === null ? '-' : String(added.plan)}\t${added.why}\t${origin}\n`)
      process.exitCode = added.state === 'refused' ? 1 : 0
    })

  queue.command('list').action(() => {
    const handle = db()
    out(laneLine(lanes(handle, hhmm(handle))))
    const rows = handle.prepare(`SELECT t.id, t.repo, t.issue_no, t.part, t.state, t.named_merger, t.evidence_measured_at, t.coo_take
      FROM targets t ORDER BY t.id`).all() as Record<string, string | number | null>[]
    for (const r of rows) out(`${String(r.id)}\t${String(r.repo)}#${String(r.issue_no)}${r.part === '' ? '' : ` ${String(r.part)}`}\t${String(r.state)}\t${String(r.named_merger)}\t${String(r.evidence_measured_at)}\t${String(r.coo_take ?? '-')}\n`)
  })

  queue.command('note').argument('<id>').argument('<take>', 'the coo\'s line: take ... or skip ...').action((id: string, take: string) => {
    note(db(), Number(id), take)
    out(`target ${id} noted\n`)
  })
}

function planned(cf: Command, { root, db, out }: Cli): Command {
  const plan = cf.command('plan')

  plan.command('add').requiredOption('--issue <ref>', 'an <owner/repo>#<n> github issue')
    .option('--pipe <name>', 'pipe to file the plan on; the lane\'s own by default')
    .action((options: { issue: string; pipe?: string }) => {
      const filed = fileIssue(db(), root, options.issue, options.pipe)
      const origin = filed.origin === null ? '-' : `${filed.origin.origin_kind}:${filed.origin.origin_ref}`
      const ruled = filed.ruling === null ? '-' : `ruling ${String(filed.ruling)}`
      out(`plan ${filed.plan === null ? '-' : String(filed.plan)} ${filed.state}\t${filed.lane ?? '-'}\t${filed.seat ?? '-'}\t${filed.why}\t${origin}\t${ruled}\n`)
      process.exitCode = filed.state === 'refused' ? 1 : 0
    })

  cf.command('plans').option('--unfiled', 'open caliperforge issues no plan row names').action((options: { unfiled?: boolean }) => {
    const handle = db()
    if (options.unfiled !== true) {
      out(section('open plans', openPlans(handle)))
      return
    }
    const rows = unfiled(handle)
    out(`unfiled (${String(rows.length)})\n`)
    for (const row of rows) out(`  ${renderUnfiled(row)}`)
  })
  return plan
}

function shown(plan: Command, { db, out }: Cli): void {
  plan.argument('<id>').action((id: string) => {
    const handle = db()
    const row = handle.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id))
    if (row === undefined) throw new Error(`no plan ${id}`)
    const plan = PlanRow.parse(row)
    const code = blocked(handle, plan)
    const why = code === null ? 'unblocked' : parked(handle, plan) ?? WAITING[code]
    const lease = holder(handle, plan.id)
    out(`plan ${String(plan.id)}\t${plan.template}\tstep ${String(plan.step)}\t${plan.state}\tretries ${String(plan.retries)}\t${why}\n`)
    const on = (handle.prepare('SELECT waits_on FROM plans WHERE id = ?').get(plan.id) as { waits_on: number | null }).waits_on
    const after = on === null ? '' : `\tplan ${String(on)}`
    out(`  waiting on ${plan.wait_reason === null ? '-' : `${plan.wait_reason}\t${WAITING[plan.wait_reason]}${after}`}\n`)
    out(`  lease ${lease === null ? 'none' : `pid ${String(lease.pid)}\ttaken ${lease.taken_at}`}\n`)
    for (const r of runsOf(handle, plan.id)) {
      out(`  run ${String(r.id)}\tstep ${String(r.step)}\t${String(r.seat)}\texit ${String(r.exit)}\n`)
    }
    for (const v of verdictsOf(handle, plan.id)) {
      out(`  verdict ${String(v.id)}\tstep ${String(v.step)}\t${String(v.gate)}\t${String(v.outcome)}\t${String(v.origin_ref ?? '-')}\n`)
    }
  })
}

function holds(cf: Command, { root, db, out }: Cli): void {
  cf.command('reap').description("remove the checkout of every plan no step is coming back for").action(() => {
    const gone = reap(root, terminal(db()))
    out(`reaped ${String(gone.length)} checkout(s)${gone.length === 0 ? '' : `: ${gone.join(', ')}`}\n`)
  })

  cf.command('release').argument('<plan>', 'a briefed plan waiting on the coo to read it').action((id: string) => {
    release(db(), Number(id))
    out(`plan ${id} queued\n`)
  })

  cf.command('return').argument('<plan>', 'a plan blocked on the ceo, held or halted').action((id: string) => {
    unhold(db(), root, Number(id), 'ceo')
    out(`plan ${id} queued\n`)
  })

  cf.command('park').argument('<plan>', 'a plan to hold where it stands, checkout kept')
    .option('--on <plan>', 'the plan it waits on; it goes back in its lane when that one lands')
    .option('--why <text>', 'why it is held', 'held by a person')
    .action((id: string, options: { on?: string; why: string }) => {
      const handle = db()
      const n = Number(id)
      if (holder(handle, n) !== null) throw new Error(`plan ${id} is mid-step in a live tick; park it once the tick lets go`)
      const on = options.on === undefined ? null : Number(options.on)
      if (on !== null && handle.prepare("SELECT 1 FROM plans WHERE id = ? AND state IN ('queued', 'running', 'blocked_on_ceo')").get(on) === undefined) {
        throw new Error(`plan ${String(on)} is not open, so nothing would release plan ${id}`)
      }
      hold(handle, root, n, options.why, new Date(), on)
      out(`plan ${id} held${on === null ? '' : ` on plan ${String(on)}`}\n`)
    })

  cf.command('unpark').argument('<plan>', 'a held plan, put back at the step it stopped on').action((id: string) => {
    const step = unhold(db(), root, Number(id), 'ceo')
    out(`plan ${id} queued at step ${String(step)}\n`)
  })
}

export function registerRetry(cf: Command, { root, db, out }: Cli): void {
  cf.command('retry').argument('<plan>', 'a plan blocked on a refusal, sent round again with its count cleared')
    .action((id: string) => {
      const n = Number(id)
      const step = retried(db(), n, 'ceo')
      afresh(root, n, step)
      out(`plan ${id} running again at step ${String(step)}\n`)
    })
}
