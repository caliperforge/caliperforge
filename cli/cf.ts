#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import { credential } from '../providers/credential.ts'
import { self } from '../rails/tight/index.ts'
import { fire } from '../runner/index.ts'
import { CHAIN_MINUTES, dry, EACH, tick } from '../sequencer/index.ts'
import { CHECK_SLOTS } from '../sequencer/checks.ts'
import { behind, upgraded } from '../sequencer/upgrade.ts'
import { saved } from '../sequencer/hq.ts'
import { signoffs } from '../sequencer/signoff.ts'
import { hold, isHeld, unhold } from '../sequencer/hold.ts'
import { SIGNOFF, afresh, liveTree, reap } from '../sequencer/workspace.ts'
import { blocked, parked, targetDigest, WAITING } from '../sequencer/steps.ts'
import { release } from '../store/holds.ts'
import { dump, migrate, open as openDb, type Db } from '../store/index.ts'
import { dial, hhmm, lanes, priority as setPriority, record, Reading, set, windows } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { PlanRow, openPipes, overlapWaits, retry, terminal } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { refusedPush } from '../store/approvals.ts'
import { receipt } from '../store/ticks.ts'
import { adopt, render as renderAdopt } from './adopt.ts'
import { approve as approveCard, batch, landed, refuse as refuseCard, render, renderLanded } from './batch.ts'
import { awaiting, day, dryLines, halted, laneLine, open as openPlans, runsOf, section, tickets, ticketSection,
  tickNote, verdictsOf, windowLine } from './brief.ts'
import { check, fill } from './digests.ts'
import { desk, gh } from './gh.ts'
import { ack, crashed, events, line, notify, record as keep, unread } from './inbox.ts'
import { measure, render as renderPulse } from './measure.ts'
import { add as fileIssue, render as renderUnfiled, unfiled } from './plan.ts'
import { add } from './queue.ts'
import { close } from './session.ts'
import { alerter, CRASHED, liveness, livenessLine, stalledLanes, watch } from './watch.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const out = (text: string): void => void process.stdout.write(text)

function db(): Db {
  const handle = openDb(join(root, 'cf.db'))
  migrate(handle, join(root, 'schema'))
  return handle
}

const cf = new Command('cf').version(pkg.version)

cf.command('migrate').action(() => {
  for (const file of migrate(openDb(join(root, 'cf.db')), join(root, 'schema'))) out(`applied ${file}\n`)
})

cf.command('digests').option('--check', 'write nothing; name each digest the tree contradicts')
  .action((options: { check?: boolean }) => {
    const today = new Date().toISOString().slice(0, 10)
    if (options.check === true) {
      const stale = check(root, today)
      for (const s of stale) {
        process.stderr.write(`cf: ${s.path} is not what cf digests writes\n`)
        for (const [id, hash] of Object.entries(s.digests)) process.stderr.write(`cf:   ${id} should be ${hash}\n`)
      }
      process.exitCode = stale.length === 0 ? 0 : 1
      return
    }
    const written = fill(root, today)
    out(written.length === 0 ? 'digests already right\n' : written.map((p) => `wrote ${p}\n`).join(''))
  })

cf.command('dump').argument('[out]', 'file to write the dump to', 'cf.dump.sql').action((file: string) => {
  const path = resolve(root, file)
  dump(openDb(join(root, 'cf.db')), path)
  out(`dumped to ${path}\n`)
})

cf.command('runs').action(() => {
  const rows = db().prepare('SELECT id, seat, step, exit, input_tokens + cache_tokens + output_tokens AS tokens, seconds FROM runs ORDER BY id')
    .all() as { id: number; seat: string; step: number; exit: number; tokens: number; seconds: number }[]
  for (const r of rows) out(`${String(r.id)}\t${r.seat}\t${String(r.step)}\t${String(r.exit)}\t${String(r.tokens)}\t${r.seconds.toFixed(1)}\n`)
})

cf.command('fire').argument('<seat>').argument('<issue-file>')
  .option('--cwd <dir>', 'checkout the seat writes in', process.cwd())
  .action(async (name: string, issue: string, options: { cwd: string }) => {
    const cwd = resolve(options.cwd)
    if (liveTree(root, cwd)) throw new Error(`${cwd} is the machine's own tree; a seat works in .cf/work/<plan>/src`)
    const run = await fire(db(), root, name, cwd, readFileSync(issue, 'utf8'), claudeAgentSdk)
    process.stderr.write(`run ${String(run.id)}\n`)
    out(run.text)
  })

cf.command('pipe').argument('<state>', 'on or off').argument('<name>').action((state: string, name: string) => {
  if (state !== 'on' && state !== 'off') throw new Error('cf pipe takes on or off')
  const handle = db()
  handle.prepare("INSERT OR IGNORE INTO pipes (name, enabled, window_start, window_end, max_concurrent) VALUES (?, 0, '00:00', '23:59', 1)").run(name)
  handle.prepare('UPDATE pipes SET enabled = ? WHERE name = ?').run(state === 'on' ? 1 : 0, name)
  out(`pipe ${name} ${state}\n`)
})

cf.command('priority').argument('<plan>').argument('<n>', 'P0 first, up to P9')
  .action((id: string, n: string) => {
    const handle = db()
    setPriority(handle, Number(id), Number(n))
    out(`plan ${id} priority P${n}\n`)
  })

cf.command('lanes').argument('[n]', 'lanes the ceo opens, 0 to the ceiling').action((n: string | undefined) => {
  const handle = db()
  if (n !== undefined) dial(handle, Number(n), new Date().toISOString())
  out(laneLine(lanes(handle, hhmm(handle))))
})

cf.command('hq').argument('<dir>', 'the HQ checkout every job end commits and pushes').action((dir: string) => {
  set(db(), 'hq.path', resolve(dir), 'ceo', new Date().toISOString().slice(0, 10))
  out(`hq ${resolve(dir)}\n`)
})

cf.command('usage').argument('[file]', 'a provider rate-limit reading, json').action((file: string | undefined) => {
  const handle = db()
  if (file !== undefined) record(handle, Reading.parse(JSON.parse(readFileSync(resolve(file), 'utf8'))))
  out(laneLine(lanes(handle, hhmm(handle))))
  for (const w of windows(handle)) out(windowLine(w))
})

cf.command('measure').argument('<repo>', 'owner/repo to take the step 0 pulse of').action((repo: string) => {
  out(renderPulse(measure(db(), repo, new Date().toISOString().slice(0, 10))))
})

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
  const rows = handle.prepare(`SELECT t.id, t.repo, t.issue_no, t.part, t.state, t.named_merger, t.evidence_measured_at
    FROM targets t ORDER BY t.id`).all() as Record<string, string | number>[]
  for (const r of rows) out(`${String(r.id)}\t${String(r.repo)}#${String(r.issue_no)}${r.part === '' ? '' : ` ${String(r.part)}`}\t${String(r.state)}\t${String(r.named_merger)}\t${String(r.evidence_measured_at)}\n`)
})

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

cf.command('reap').description("remove the checkout of every plan no step is coming back for").action(() => {
  const gone = reap(root, terminal(db()))
  out(`reaped ${String(gone.length)} checkout(s)${gone.length === 0 ? '' : `: ${gone.join(', ')}`}\n`)
})

cf.command('release').argument('<plan>', 'a briefed plan waiting on the coo to read it').action((id: string) => {
  release(db(), Number(id))
  out(`plan ${id} queued\n`)
})

cf.command('return').argument('<plan>', 'a plan blocked on the ceo, held or halted').action((id: string) => {
  unhold(db(), root, Number(id))
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
  const step = unhold(db(), root, Number(id))
  out(`plan ${id} queued at step ${String(step)}\n`)
})

cf.command('inbox').option('--ack', 'mark everything shown so far as read')
  .description('what ticks did that a person may need to act on, unread first')
  .action((options: { ack?: boolean }) => {
    const handle = db()
    const news = unread(root)
    if (news.length === 0) out('inbox empty\n')
    for (const e of news) out(`${line(handle, e)}\n`)
    if (options.ack === true) out(`${String(ack(root))} marked read\n`)
  })

cf.command('tight').description('the Tight rail on this checkout against main, as step 3 will run it').action(() => {
  const verdict = self(process.cwd())
  out(`${verdict.message}\n`)
  for (const span of verdict.spans) out(`  ${span}\n`)
  process.exitCode = verdict.outcome === 'pass' ? 0 : 1
})

cf.command('retry').argument('<plan>', 'a plan blocked on a refusal, sent round again with its count cleared')
  .action((id: string) => {
    const handle = db()
    const row = handle.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id))
    if (row === undefined) throw new Error(`no plan ${id}`)
    const plan = PlanRow.parse(row)
    if (plan.state !== 'blocked_on_ceo') throw new Error(`plan ${id} is ${plan.state}, not blocked`)
    const step = handle.transaction(() => { clear(handle, plan.id); return retry(handle, plan) })()
    afresh(root, plan.id, step)
    out(`plan ${id} running again at step ${String(step)}\n`)
  })

const approve = cf.command('approve')

const refuse = cf.command('refuse')

approve.command('target').argument('<id>').action((id: string) => {
  const handle = db()
  const t = handle.prepare('SELECT repo, issue_no, evidence_measured_at FROM targets WHERE id = ?').get(Number(id)) as
    { repo: string; issue_no: number; evidence_measured_at: string } | undefined
  if (t === undefined) throw new Error(`no target ${id}`)
  const at = new Date().toISOString()
  const digest = targetDigest(t)
  handle.prepare(`INSERT OR IGNORE INTO approvals (subject_kind, subject_id, subject_digest, who, decision, approved_at)
    VALUES ('target', ?, ?, 'ceo', 'approved', ?)`).run(Number(id), digest, at)
  out(`target ${id} approved\t${digest.slice(0, 12)}\n`)
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

const session = cf.command('session')

session.command('close').argument('<transcript>').action((path: string) => {
  const made = close(db(), resolve(path))
  out(`${String(made.length)} proposal(s) in the batch\n`)
})

cf.command('push-check').action(() => {
  const refused = refusedPush(db(), readFileSync(0, 'utf8'))
  for (const sha of refused) process.stderr.write(`cf: no ceo approval row for ${sha.slice(0, 12)}\n`)
  process.exitCode = refused.length === 0 ? 0 : 1
})

cf.command('halted').action(() => {
  out(section('halted', halted(db())))
})

cf.command('brief').action(() => {
  const handle = db()
  out(livenessLine(handle, liveness(handle, new Date())))
  for (const lane of stalledLanes(handle, new Date())) out(`lane\tOFF with work: ${lane}\n`)
  out(laneLine(lanes(handle, hhmm(handle))))
  out(section('open plans', openPlans(handle)))
  out(section('halted', halted(handle)))
  const waiting = awaiting(handle)
  out(section('held', waiting.filter((l) => isHeld(root, l.id))))
  out(section('awaiting approval', waiting.filter((l) => !isHeld(root, l.id))))
  const d = day(handle)
  out(`last 24 h\n  ${String(d.runs)} run(s)\t${String(d.tokens)} tokens\t${d.seconds.toFixed(1)}s\n`)
  out(ticketSection(tickets(handle)))
})

cf.command('adopt').argument('<ref>', 'an <owner/repo>#<n> pull request of ours that is already open')
  .action((ref: string) => {
    out(renderAdopt(adopt(db(), root, ref, new Date().toISOString().slice(0, 10))))
  })

cf.command('tick').option('--dry', 'read what a tick would do, fire nothing, call no network')
  .action(async (options: { dry?: boolean }) => {
    const now = new Date()
    await ticked(options, now).catch((error: unknown) => {
      crashed(root, now.toISOString(), error)
      down(now, error)
      throw error
    })
  })

/** #251: a tick that threw leaves a receipt saying so and raises the alert, or the table reads a dead machine as an idle one. */
function down(now: Date, error: unknown): void {
  try {
    const handle = db()
    const message = error instanceof Error ? error.message : String(error)
    receipt(handle, { at: now.toISOString(), hhmm: hhmm(handle, now), dry: false,
      pipes: openPipes(handle, hhmm(handle, now)).length, fired: 0, exit: 1, note: `${CRASHED}${message.slice(0, 500)}` })
    watch(handle, root, now, alerter())
  } catch {
    return
  }
}

cf.command('watch').description('alert once when no real tick has landed inside an open window, and once when one lands again')
  .action(() => {
    const handle = db()
    out(livenessLine(handle, watch(handle, root, new Date(), alerter())))
  })

async function ticked(options: { dry?: boolean }, now: Date): Promise<void> {
  const handle = db()
  if (options.dry === true) {
    dryTick(handle, now)
    return
  }
  const sha = behind(handle, root)
  if (sha !== null) {
    halt(handle, now, sha)
    return
  }
  const { auth } = credential()
  process.stderr.write(`auth ${auth.kind} from ${auth.from}\n`)
  process.env.CF_CHECK_SLOTS ??= String(CHECK_SLOTS)
  const fired = await tick(handle, root, claudeAgentSdk, now, undefined, undefined, CHAIN_MINUTES, gh, EACH)
  receipt(handle, saved(handle, upgraded(handle, root, { at: now.toISOString(), hhmm: hhmm(handle, now), dry: false,
    pipes: openPipes(handle, hhmm(handle, now)).length, fired: fired.length,
    exit: fired.some((f) => f.outcome === 'refuse') ? 1 : 0, note: tickNote(fired, overlapWaits(handle)) }),
  fired.filter((f) => f.state === 'done').map((f) => f.plan)))
  watch(handle, root, now, alerter())
  const news = events(handle, fired, now.toISOString())
  keep(root, news)
  notify(news)
  if (fired.length === 0) out('nothing to fire\n')
  for (const f of fired) {
    out(`${f.pipe}\tplan ${String(f.plan)}\tstep ${String(f.step)} ${f.name}\t${f.outcome}\t${f.state}\t${f.note}\n`)
    for (const span of f.spans) out(`  span\t${span}\n`)
  }
  cards(handle, now)
}

cf.command('signoff').description('open, read and close the sign-off cards on the private sign-off repo, as every tick does')
  .action(() => { cards(db(), new Date()) })

/** A tracker that cannot be read this time leaves every card where it stands; the next tick reads it again. */
function cards(handle: Db, now: Date): void {
  try {
    for (const s of signoffs(handle, root, desk(SIGNOFF), now)) out(`signoff\tplan ${String(s.plan)}\tcard ${String(s.card)}\t${s.did}\n`)
  } catch (error) {
    process.stderr.write(`cf: sign-off cards: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** Until the tree holds what it merged it would fire a lap of a version it has already replaced. */
function halt(handle: Db, now: Date, sha: string): void {
  const note = `live tree is behind ${sha.slice(0, 12)}; it fires nothing until it holds that commit`
  process.stderr.write(`cf: ${note}\n`)
  receipt(handle, { at: now.toISOString(), hhmm: hhmm(handle, now), dry: false,
    pipes: openPipes(handle, hhmm(handle, now)).length, fired: 0, exit: 1, note })
  process.exitCode = 1
}

function dryTick(handle: Db, now: Date): void {
  const would = dry(handle, now)
  out(dryLines(would))
  receipt(handle, { at: now.toISOString(), hhmm: would.hhmm, dry: true, pipes: would.pipes,
    fired: 0, exit: 0, note: tickNote([], overlapWaits(handle)) })
}

try {
  await cf.parseAsync()
} catch (error) {
  process.stderr.write(`cf: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
