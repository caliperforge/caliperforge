import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { claudeAgentSdk } from '../providers/claude-agent-sdk/index.ts'
import { self } from '../rails/tight/index.ts'
import { fire } from '../runner/index.ts'
import { reviewed } from '../sequencer/ready.ts'
import { liveTree, SELF } from '../sequencer/workspace.ts'
import { dump, migrate, open as openDb, type Db } from '../store/index.ts'
import { dial, hhmm, lanes, priority as setPriority, record, Reading, windows } from '../store/lanes.ts'
import { refusedPush } from '../store/approvals.ts'
import { drifts } from '../store/drift.ts'
import { repriced } from '../store/events.ts'
import { holderOf, HOLDERS, overlapWaits, parked } from '../store/plans.ts'
import { backfillTickets } from '../store/tickets.ts'
import { backfill } from '../store/transcript.ts'
import { actors, actorSection, byType, type ByType, costs, costSection, day, fileWaits, greptileLine, halted, hands, heldBy, laneLine, misses, missSection, open as openPlans,
  rulings, section, tickets, ticketSection, unpriced, waitLine, waits, windowLine } from './brief.ts'
import { check, fill } from './digests.ts'
import { driftSection } from './drift.ts'
import { flow } from './flow.ts'
import { gh } from './gh.ts'
import { write as writeMap } from './map.ts'
import { ack, line, unread } from './inbox.ts'
import { close } from './session.ts'
import { liveness, livenessLine, stalledLanes } from './watch.ts'

export interface Cli { root: string; db: () => Db; out: (text: string) => void }

export function registerLanes(cf: Command, cli: Cli): void {
  stores(cf, cli)
  fires(cf, cli)
  dials(cf, cli)
}

function stores(cf: Command, { root, db, out }: Cli): void {
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

  cf.command('map').argument('[dir]', 'the tree to map', '.').action((dir: string) => {
    out(`wrote ${writeMap(resolve(dir))}\n`)
  })

  cf.command('dump').argument('[out]', 'file to write the dump to', 'cf.dump.sql').action((file: string) => {
    const path = resolve(root, file)
    dump(openDb(join(root, 'cf.db')), path)
    out(`dumped to ${path}\n`)
  })

  cf.command('runs').action(() => {
    const rows = db().prepare(`SELECT id, seat, step, exit, input_tokens + cache_read_tokens + output_tokens AS tokens, seconds,
      input_tokens - coalesce(cache_write_tokens, 0) AS uncached_tokens, coalesce(cache_write_tokens, 0) AS cache_write_tokens,
      cache_read_tokens, output_tokens FROM runs ORDER BY id`)
      .all() as ({ id: number; seat: string; step: number; exit: number; tokens: number; seconds: number } & ByType)[]
    for (const r of rows) out(`${String(r.id)}\t${r.seat}\t${String(r.step)}\t${String(r.exit)}\t${String(r.tokens)}\t${r.seconds.toFixed(1)}\t${byType(r)}\n`)
  })
}

function fires(cf: Command, { root, db, out }: Cli): void {
  cf.command('backfill-cost').action(() => {
    const handle = db()
    out(`backfilled ${String(backfill(handle))} run(s)\n`)
    const { priced, missing } = repriced(handle)
    out(`priced ${String(priced)} run(s); ${String(missing.length)} missing cache writes: ${missing.join(', ')}\n`)
  })

  cf.command('backfill-tickets').action(() => {
    out(`backfilled ${String(backfillTickets(db(), gh))} ticket(s)\n`)
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
    .requiredOption('--by <actor>', `who ran it: ${HOLDERS.join(' or ')}`)
    .requiredOption('--why <text>', 'why the order changes')
    .action((id: string, n: string, options: { by: string; why: string }) => {
      const by = holderOf(options.by)
      const handle = db()
      setPriority(handle, Number(id), Number(n), { actor: by, why: options.why })
      out(`plan ${id} priority P${n}\n`)
    })
}

function dials(cf: Command, { db, out }: Cli): void {
  cf.command('lanes').argument('[n]', 'lanes the ceo opens, 0 to the ceiling').action((n: string | undefined) => {
    const handle = db()
    if (n !== undefined) dial(handle, Number(n), new Date().toISOString())
    out(laneLine(lanes(handle, hhmm(handle))))
  })

  cf.command('usage').argument('[file]', 'a provider rate-limit reading, json').action((file: string | undefined) => {
    const handle = db()
    if (file !== undefined) record(handle, Reading.parse(JSON.parse(readFileSync(resolve(file), 'utf8'))))
    out(laneLine(lanes(handle, hhmm(handle))))
    for (const w of windows(handle)) out(windowLine(w))
  })
}

export function registerInbox(cf: Command, { root, db, out }: Cli): void {
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
}

export function registerSession(cf: Command, { root, db, out }: Cli): void {
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

  cf.command('flow').action(() => {
    const lines = flow(db(), root, new Date())
    out(lines.length === 0 ? 'flow clear\n' : lines.join(''))
  })

  briefs(cf, { root, db, out })
}

function briefs(cf: Command, { root, db, out }: Cli): void {
  cf.command('brief').action(() => {
    const handle = db()
    out(livenessLine(handle, liveness(handle, new Date())))
    for (const lane of stalledLanes(handle, new Date())) out(`lane\tOFF with work: ${lane}\n`)
    out(rulings(handle, root))
    out(driftSection(drifts(handle, SELF, new Date())))
    out(laneLine(lanes(handle, hhmm(handle))))
    out(waitLine(waits(handle)) + fileWaits(overlapWaits(handle)))
    out(greptileLine(reviewed(handle, new Date())))
    out(missSection(misses(handle, root, new Date())))
    out(section('open plans', openPlans(handle)))
    out(section('halted', halted(handle)))
    out(section('waiting on the CEO', heldBy(handle, 'ceo')))
    out(section('needs a decision', heldBy(handle, 'coo')) + section('parked on another job', parked(handle)))
    const d = day(handle)
    out(`last 24 h\n  ${String(d.runs)} run(s)\t${String(d.tokens)} tokens\t${d.seconds.toFixed(1)}s\n`)
    out(costSection(costs(handle), unpriced(handle)))
    const now = new Date()
    out(actorSection(actors(handle, now), hands(now, gh)))
    out(ticketSection(tickets(handle)))
  })
}
