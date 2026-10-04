import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { hold, unhold } from '../sequencer/hold.ts'
import { afresh, reap } from '../sequencer/workspace.ts'
import { blocked, parked, WAITING } from '../sequencer/steps.ts'
import { logged } from '../store/events.ts'
import { edit, VERBS } from '../store/files.ts'
import { closed, release, retried } from '../store/holds.ts'
import { hhmm, lanes } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { held, holderOf, HOLDERS, planById, terminal } from '../store/plans.ts'
import { until } from '../store/until.ts'
import { laneLine, open as openPlans, runsOf, section, verdictsOf } from './brief.ts'
import type { Cli } from './cf-lanes.ts'
import { add as fileIssue, render as renderUnfiled, unfiled } from './plan.ts'
import { add, note } from './queue.ts'

const BY = ['--by <actor>', `who ran it: ${HOLDERS.join(' or ')}`] as const

export function registerPlans(cf: Command, cli: Cli): void {
  queues(cf, cli)
  shown(planned(cf, cli), cli)
  holds(cf, cli)
  parks(cf, cli)
  closes(cf, cli)
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
    .requiredOption('--by <who>', `who files it: ${HOLDERS.join(' or ')}`)
    .option('--pipe <name>', 'pipe to file the plan on; the lane\'s own by default')
    .action((options: { issue: string; by: string; pipe?: string }) => {
      const by = holderOf(options.by)
      const filed = fileIssue(db(), root, options.issue, by, options.pipe)
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
    const plan = planById(handle, Number(id))
    const code = blocked(handle, plan)
    const why = code === null ? 'unblocked' : parked(handle, plan) ?? WAITING[code]
    const lease = holder(handle, plan.id)
    const condition = until(handle, plan.id)
    out(`plan ${String(plan.id)}\t${plan.template}\tstep ${String(plan.step)}\t${plan.state}\tretries ${String(plan.retries)}\t${why}${condition === null ? '' : `\t${condition}`}\n`)
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

  cf.command('release').argument('<plan>', 'a briefed plan waiting on the coo to read it').requiredOption(...BY)
    .action((id: string, options: { by: string }) => {
      release(db(), Number(id), holderOf(options.by))
      out(`plan ${id} queued\n`)
    })

  cf.command('return').argument('<plan>', 'a plan blocked on the ceo, held or halted').requiredOption(...BY)
    .option('--to <step>', 'an earlier step to resume at, retries and signed head cleared')
    .action((id: string, options: { by: string; to?: string }) => {
      const to = options.to === undefined ? undefined : Number(options.to)
      const step = unhold(db(), root, Number(id), holderOf(options.by), to)
      out(`plan ${id} queued at step ${String(step)}\n`)
    })
}

function parks(cf: Command, { root, db, out }: Cli): void {
  cf.command('park').argument('<plan>', 'a plan to hold where it stands, checkout kept')
    .option('--on <plan>', 'the plan it waits on; it goes back in its lane when that one lands')
    .option('--why <text>', 'why it is held', 'held by a person').requiredOption(...BY)
    .action((id: string, options: { on?: string; why: string; by: string }) => {
      const actor = holderOf(options.by)
      const handle = db()
      const n = Number(id)
      if (holder(handle, n) !== null) throw new Error(`plan ${id} is mid-step in a live tick; park it once the tick lets go`)
      const on = options.on === undefined ? null : Number(options.on)
      if (on !== null && handle.prepare("SELECT 1 FROM plans WHERE id = ? AND state IN ('queued', 'running', 'blocked_on_ceo')").get(on) === undefined) {
        throw new Error(`plan ${String(on)} is not open, so nothing would release plan ${id}`)
      }
      hold(handle, root, n, options.why, new Date(), on)
      logged(handle, { plan: n, kind: 'park', actor, outcome: 'pass', message: options.why, pointer: null, run: null })
      out(`plan ${id} held${on === null ? '' : ` on plan ${String(on)}`}\n`)
    })

  cf.command('hold').argument('<plan>', 'a plan to hold where it stands, checkout kept')
    .requiredOption('--by <holder>', `who it waits on: ${HOLDERS.join(' or ')}`)
    .requiredOption('--why <text>', 'why it is held')
    .requiredOption('--as <actor>', `who ran it: ${HOLDERS.join(' or ')}`)
    .action((id: string, options: { by: string; why: string; as: string }) => {
      const by = holderOf(options.by)
      const actor = holderOf(options.as)
      const handle = db()
      const n = Number(id)
      if (holder(handle, n) !== null) throw new Error(`plan ${id} is mid-step in a live tick; hold it once the tick lets go`)
      hold(handle, root, n, options.why, new Date())
      held(handle, n, by, options.why)
      logged(handle, { plan: n, kind: 'hold', actor, outcome: 'pass', message: options.why, pointer: null, run: null })
      out(`plan ${id} held on the ${by}\n`)
    })

  cf.command('unpark').argument('<plan>', 'a held plan, put back at the step it stopped on').requiredOption(...BY)
    .action((id: string, options: { by: string }) => {
      const step = unhold(db(), root, Number(id), holderOf(options.by))
      out(`plan ${id} queued at step ${String(step)}\n`)
    })
}

function closes(cf: Command, { db, out }: Cli): void {
  cf.command('files').argument('<plan>').argument('<verb>', VERBS.join(', ')).argument('<path>')
    .requiredOption(...BY)
    .option('--why <text>', 'why the list changes')
    .action((id: string, said: string, path: string, options: { by: string; why?: string }) => {
      const by = holderOf(options.by)
      const verb = VERBS.find((v) => v === said)
      if (verb === undefined) throw new Error(`<verb> takes ${VERBS.join(', ')}, not ${said}`)
      edit(db(), Number(id), verb, path, by, options.why ?? null)
      out(`plan ${id} ${verb} ${path}\n`)
    })

  cf.command('close').argument('<plan>', 'a plan settled by hand, checkout kept for cf reap')
    .requiredOption('--why <text>', 'why it is closed')
    .requiredOption(...BY)
    .option('--as <state>', 'refused or done', 'refused')
    .action((id: string, options: { why: string; by: string; as: string }) => {
      const by = holderOf(options.by)
      if (options.as !== 'refused' && options.as !== 'done') throw new Error(`--as takes refused or done, not ${options.as}`)
      const handle = db()
      if (holder(handle, Number(id)) !== null) throw new Error(`plan ${id} is mid-step in a live tick; close it once the tick lets go`)
      closed(handle, Number(id), options.as, by, options.why)
      out(`plan ${id} ${options.as}\n`)
    })
}

export function registerRetry(cf: Command, { root, db, out }: Cli): void {
  cf.command('retry').argument('<plan>', 'a plan blocked on a refusal, sent round again with its count cleared')
    .requiredOption(...BY)
    .action((id: string, options: { by: string }) => {
      const n = Number(id)
      const step = retried(db(), n, holderOf(options.by))
      afresh(root, n, step)
      out(`plan ${id} running again at step ${String(step)}\n`)
    })
}
