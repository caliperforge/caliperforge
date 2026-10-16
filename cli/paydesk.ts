import type { Command } from 'commander'
import { lookup } from 'node:dns/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { merge, render, rows, type Fix } from '../paydesk/fixlist.ts'
import { live, providers, recheck, verdict } from '../paydesk/live.ts'
import { note } from '../paydesk/note.ts'
import { prs, type Row } from '../paydesk/prs.ts'
import { scan, type Net } from '../paydesk/scan.ts'
import { paid } from '../store/paydesk-paid.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPaydesk(cf: Command, { root, out }: Cli): void {
  const net: Net = { fetch, resolve: (host) => lookup(host) }
  const paydesk = registerPaid(cf.command('paydesk'), out)
  paydesk.command('scan').argument('<dir...>').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (dirs: string[], options: { out: string; cards?: string }) => {
      const results = await scan(dirs, options.out, options.cards, net)
      const crashed = results.filter((r) => 'crash' in r).length
      out(`${String(results.length)} listings, ${String(crashed)} crashed -> ${options.out}\n`)
    })
  paydesk.command('prs').requiredOption('--out <file>').option('--cards <dir>')
    .action(async (options: { out: string; cards?: string }) => {
      const ran = await prs(root, options.out, options.cards, net)
      const crashed = ran.listings.filter((r) => 'crash' in r).length
      out(`${String(ran.prs)} PRs, ${String(ran.listings.length)} listings, ${String(crashed)} crashed, ${String(ran.skipped.length)} skipped -> ${options.out}\n`)
    })
  paydesk.command('live').action(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pay-skills-'))
    try {
      const dir = join(root, '.cf/paydesk')
      const date = new Date().toISOString().slice(0, 10)
      const { failing, passing, gone } = await live(dir, date, providers(tmp), net)
      out(`${String(failing.length)} newly failing, ${String(passing.length)} newly passing, ${String(gone.length)} gone -> ${join(dir, `live-${date}.md`)}\n`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  paydesk.command('recheck').argument('<fqn...>').requiredOption('--out <file>')
    .action(async (fqns: string[], options: { out: string }) => { out(await rechecked(fqns, options.out, net)) })
  paydesk.command('fixlist').argument('<scan>').argument('<checks>').requiredOption('--out <dir>')
    .action((scanFile: string, checks: string, options: { out: string }) => {
      const fixes = fixlist(scanFile, checks, options.out)
      const blocking = fixes.filter((f) => f.items.some((i) => i.blocking)).length
      out(`${String(fixes.length)} PRs, ${String(blocking)} blocking -> ${options.out}\n`)
    })
  paydesk.command('notes').argument('<scan>').requiredOption('--out <dir>').requiredOption('--from <name>')
    .action((scanFile: string, options: { out: string; from: string }) => {
      out(`${String(notes(scanFile, options.out, options.from))} notes -> ${options.out}\n`)
    })
}

function registerPaid(paydesk: Command, out: Cli['out']): Command {
  paydesk.command('paid').argument('<scan>').requiredOption('--cap <usdc>').requiredOption('--ledger <file>').requiredOption('--out <file>')
    .option('--account <name>')
    .action((scanFile: string, options: { cap: string; ledger: string; out: string; account?: string }) => {
      const ran = paid(scanned(scanFile), { cap: Number(options.cap), ledger: options.ledger, account: options.account,
        bin: process.env.PAY_BIN ?? 'pay', now: new Date() })
      writeFileSync(options.out, ran.rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
      out(`${String(ran.rows.length)} paid, ${String(ran.skipped)} skipped, $${String(ran.spent)} spent${ran.capped ? ', stopped at cap' : ''} -> ${options.out}\n`)
    })
  return paydesk
}

function scanned(file: string): Row[] {
  const text = readFileSync(file, 'utf8')
  return (text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter((l) => l.trim() !== '').map((l): unknown => JSON.parse(l))) as Row[]
}

async function rechecked(fqns: string[], file: string, net: Net): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'pay-skills-'))
  try {
    return (await recheck(providers(tmp), fqns, file, net)).map((s) => `${s.fqn} ${verdict(s)}\n`).join('')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function notes(scanFile: string, dir: string, from: string): number {
  mkdirSync(dir, { recursive: true })
  let written = 0
  for (const row of scanned(scanFile)) {
    if ('crash' in row || 'unfetched' in row) continue
    const said = note(row, from)
    if (said === null) continue
    writeFileSync(join(dir, `${row.fqn.replace('/', '__')}.md`), said)
    written++
  }
  return written
}

function fixlist(scanFile: string, checks: string, dir: string): Fix[] {
  const checked = readdirSync(checks).flatMap((name) => {
    const n = /^(\d+)\.stderr$/.exec(name)?.[1]
    return n === undefined ? [] : rows(readFileSync(join(checks, name), 'utf8'), Number(n), join(checks, n))
  })
  const fixes = merge(checked, scanned(scanFile))
  mkdirSync(dir, { recursive: true })
  for (const fix of fixes) {
    writeFileSync(join(dir, `${String(fix.pr)}.md`), render(fix))
    writeFileSync(join(dir, `${String(fix.pr)}.json`), JSON.stringify(fix, null, 2))
  }
  return fixes
}
