#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import { credential } from '../providers/credential.ts'
import { spawn } from 'node:child_process'
import { parse } from 'yaml'
import { Entry } from '../sequencer/drift.ts'
import { CHAIN_MINUTES, dry, EACH, lap, tick, type Apart } from '../sequencer/index.ts'
import { garden } from '../sequencer/garden.ts'
import type { Fired } from '../sequencer/kind.ts'
import { CHECK_SLOTS } from '../sequencer/checks.ts'
import { behind, upgraded } from '../sequencer/upgrade.ts'
import { late } from '../sequencer/signals.ts'
import { signoffs } from '../sequencer/signoff.ts'
import { byHand } from '../sequencer/director.ts'
import { SIGNOFF } from '../sequencer/workspace.ts'
import { migrate, open as openDb, type Db } from '../store/index.ts'
import { hhmm } from '../store/lanes.ts'
import { openPipes, overlapWaits } from '../store/plans.ts'
import { receipt, slots } from '../store/ticks.ts'
import { dryLines, tickNote } from './brief.ts'
import { reported, slack } from './flow.ts'
import { registerInbox, registerLanes, registerSession, type Cli } from './cf-lanes.ts'
import { registerPlans, registerRetry } from './cf-plans.ts'
import { registerAdopt, registerApprovals, registerTargets } from './cf-targets.ts'
import { registerDesk } from './desk.ts'
import { registerLook } from './look.ts'
import { desk, fileIssue, gh } from './gh.ts'
import { health } from './health.ts'
import { crashed, events, notify, record as keep } from './inbox.ts'
import { pull } from './science.ts'
import { alerter, down, livenessLine, watch } from './watch.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const out = (text: string): void => void process.stdout.write(text)

function db(): Db {
  const handle = openDb(join(root, 'cf.db'))
  migrate(handle, join(root, 'schema'))
  return handle
}

const cf = new Command('cf').version(pkg.version)
const cli: Cli = { root, db, out }

registerLanes(cf, cli)
registerTargets(cf, cli)
registerPlans(cf, cli)
registerInbox(cf, cli)
registerRetry(cf, cli)
registerApprovals(cf, cli)
registerSession(cf, cli)
registerAdopt(cf, cli)
registerDesk(cf, cli)
registerLook(cf, cli)

cf.command('health').action(() => {
  out(health(db(), root, new Date().toISOString().slice(0, 10)))
})

cf.command('science').command('pull').option('--since <date>', 'the first local day, YYYY-MM-DD')
  .action((options: { since?: string }) => {
    for (const path of pull(db(), root, new Date(), options.since)) out(`${path}\n`)
  })

cf.command('tick').option('--dry', 'read what a tick would do, fire nothing, call no network')
  .action(async (options: { dry?: boolean }) => {
    const now = new Date()
    await ticked(options, now).catch((error: unknown) => {
      crashed(root, now.toISOString(), error)
      down(db, root, now, error, alerter())
      throw error
    })
  })

/** The last line `cf lap` writes: what the job fired, for the tick that forked it. */
const FIRED = 'cf-lap-fired\t'

cf.command('lap').argument('<plan>', 'a plan the tick leased').requiredOption('--from <pid>', 'the tick holding the lease')
  .option('--stole <pid>', 'the dead tick the lease was taken over from')
  .description('run one leased job in this process, for the tick that forked it (#311)')
  .action(async (id: string, options: { from: string; stole?: string }) => {
    process.env.CF_CHECK_SLOTS ??= String(CHECK_SLOTS)
    const fired = await lap(db(), root, claudeAgentSdk, Number(id), Number(options.from),
      options.stole === undefined ? null : Number(options.stole), CHAIN_MINUTES, gh)
    out(`\n${FIRED}${JSON.stringify(fired)}\n`)
  })

/** Each leased job runs in a child process, so one job's synchronous checks never freeze another's agent. */
const apart: Apart = (plan, stole) => new Promise((done, failed) => {
  const args = [...process.execArgv, fileURLToPath(import.meta.url), 'lap', String(plan), '--from', String(process.pid),
    ...(stole === null ? [] : ['--stole', String(stole)])]
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
  let said = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { said += chunk })
  child.on('error', failed)
  child.on('close', (code) => {
    const last = said.split('\n').findLast((l) => l.startsWith(FIRED))
    if (code === 0 && last !== undefined) done(JSON.parse(last.slice(FIRED.length)) as Fired[])
    else failed(new Error(`cf lap ${String(plan)} exited ${String(code)}`))
  })
})

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
  const lines: string[] = []
  const fired = await tick(handle, root, claudeAgentSdk, now, undefined, undefined, CHAIN_MINUTES, gh, EACH, apart, lines,
    Entry.array().parse(parse(readFileSync(join(root, 'rules/registry.yaml'), 'utf8'))))
  const id = receipt(handle, upgraded(handle, root, { at: now.toISOString(), hhmm: hhmm(handle, now), dry: false,
    pipes: openPipes(handle, hhmm(handle, now)).length, fired: fired.length,
    exit: fired.some((f) => f.outcome === 'refuse') ? 1 : 0, note: tickNote(fired, overlapWaits(handle), lines) }))
  slots(handle, id, slack(handle, now))
  watch(handle, root, now, alerter())
  const news = events(handle, fired, now.toISOString())
  keep(root, news)
  notify(news)
  reported(handle, root, now)
  if (fired.length === 0) out('nothing to fire\n')
  for (const f of fired) {
    out(`${f.pipe}\tplan ${String(f.plan)}\tstep ${String(f.step)} ${f.name}\t${f.outcome}\t${f.state}\t${f.note}\n`)
    for (const span of f.spans) out(`  span\t${span}\n`)
  }
  cards(handle, now)
  const gardened = garden(handle, root, now, fileIssue)
  if (gardened !== null) out(`garden\t${gardened}\n`)
}

cf.command('signoff').description('open, read and close the sign-off cards on the private sign-off repo, as every tick does')
  .action(() => { cards(db(), new Date()) })

cf.command('coo-lite').description('fire one coo_lite run on the oldest stopped plan now, below the pile thresholds')
  .action(async () => {
    const said = await byHand(db(), root, claudeAgentSdk, new Date())
    out(`${said}\n`)
  })

/** A tracker that cannot be read this time leaves every card where it stands; the next tick reads it again. */
function cards(handle: Db, now: Date): void {
  try {
    for (const s of signoffs(handle, root, desk(SIGNOFF), now)) out(`signoff\tplan ${String(s.plan)}\tcard ${String(s.card)}\t${s.did}\n`)
    late(handle, root, desk(SIGNOFF), now)
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
