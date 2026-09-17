#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import { credential } from '../providers/credential.ts'
import { fire } from '../runner/index.ts'
import { tick } from '../sequencer/index.ts'
import { blocked, targetDigest } from '../sequencer/steps.ts'
import { dump, migrate, open as openDb, type Db } from '../store/index.ts'
import { PlanRow } from '../store/plans.ts'
import { headApproved } from '../store/approvals.ts'
import { approve as approveCard, batch, refuse as refuseCard, render } from './batch.ts'
import { awaiting, day, halted, open as openPlans, runsOf, section, verdictsOf } from './brief.ts'
import { measure, render as renderPulse } from './measure.ts'
import { add } from './queue.ts'
import { close } from './session.ts'

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
    const run = await fire(db(), root, name, resolve(options.cwd), readFileSync(issue, 'utf8'), claudeAgentSdk)
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

cf.command('measure').argument('<repo>', 'owner/repo to take the step 0 pulse of').action((repo: string) => {
  out(renderPulse(measure(db(), repo, new Date().toISOString().slice(0, 10))))
})

const queue = cf.command('queue')

queue.command('add').argument('<repo>').argument('<issue-url>').option('--pipe <name>', 'pipe to queue on', 'pr-path')
  .action((repo: string, url: string, options: { pipe: string }) => {
    const added = add(db(), root, repo, url, options.pipe, new Date().toISOString().slice(0, 10))
    out(`target ${String(added.target)} ${added.state}\tplan ${added.plan === null ? '-' : String(added.plan)}\t${added.why}\n`)
    process.exitCode = added.state === 'refused' ? 1 : 0
  })

queue.command('list').action(() => {
  const rows = db().prepare(`SELECT t.id, t.repo, t.issue_no, t.state, t.named_merger, t.evidence_measured_at
    FROM targets t ORDER BY t.id`).all() as Record<string, string | number>[]
  for (const r of rows) out(`${String(r.id)}\t${String(r.repo)}#${String(r.issue_no)}\t${String(r.state)}\t${String(r.named_merger)}\t${String(r.evidence_measured_at)}\n`)
})

cf.command('plan').argument('<id>').action((id: string) => {
  const handle = db()
  const row = handle.prepare('SELECT * FROM plans WHERE id = ?').get(Number(id))
  if (row === undefined) throw new Error(`no plan ${id}`)
  const plan = PlanRow.parse(row)
  const why = blocked(handle, plan, new Date().toISOString().slice(0, 10))
  out(`plan ${String(plan.id)}\t${plan.template}\tstep ${String(plan.step)}\t${plan.state}\tretries ${String(plan.retries)}\t${why ?? 'unblocked'}\n`)
  for (const r of runsOf(handle, plan.id)) {
    out(`  run ${String(r.id)}\tstep ${String(r.step)}\t${String(r.seat)}\texit ${String(r.exit)}\n`)
  }
  for (const v of verdictsOf(handle, plan.id)) {
    out(`  verdict ${String(v.id)}\tstep ${String(v.step)}\t${String(v.gate)}\t${String(v.outcome)}\t${String(v.origin_ref ?? '-')}\n`)
  }
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
  const cards = batch(db(), root)
  if (cards.length === 0) out('nothing awaiting sign-off\n')
  for (const card of cards) out(render(card))
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

/** `hooks/pre-push` runs this; git hands it `<local ref> <local sha> <remote ref> <remote sha>` on stdin. */
cf.command('push-check').action(() => {
  const handle = db()
  const refused = readFileSync(0, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((line) => line.split(' ')[1] ?? '')
    .filter((sha) => !/^0{40,}$/.test(sha) && !headApproved(handle, sha))
  for (const sha of refused) process.stderr.write(`cf: no ceo approval row for ${sha.slice(0, 12)}\n`)
  process.exitCode = refused.length === 0 ? 0 : 1
})

cf.command('halted').action(() => {
  out(section('halted', halted(db())))
})

cf.command('brief').action(() => {
  const handle = db()
  out(section('open plans', openPlans(handle)))
  out(section('halted', halted(handle)))
  out(section('awaiting approval', awaiting(handle)))
  const d = day(handle)
  out(`last 24 h\n  ${String(d.runs)} run(s)\t${String(d.tokens)} tokens\t${d.seconds.toFixed(1)}s\n`)
})

cf.command('tick').action(async () => {
  const { auth } = credential()
  process.stderr.write(`auth ${auth.kind} from ${auth.from}\n`)
  const fired = await tick(db(), root, claudeAgentSdk)
  if (fired.length === 0) out('nothing to fire\n')
  for (const f of fired) {
    out(`${f.pipe}\tplan ${String(f.plan)}\tstep ${String(f.step)} ${f.name}\t${f.outcome}\t${f.state}\t${f.note}\n`)
    for (const span of f.spans) out(`  span\t${span}\n`)
  }
})

try {
  await cf.parseAsync()
} catch (error) {
  process.stderr.write(`cf: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
