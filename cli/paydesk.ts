import type { Command } from 'commander'
import { lookup } from 'node:dns/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { merge, render, rows, type Fix } from '../paydesk/fixlist.ts'
import { live, providers } from '../paydesk/live.ts'
import { note } from '../paydesk/note.ts'
import { prs, type Row } from '../paydesk/prs.ts'
import { scan, type Net } from '../paydesk/scan.ts'
import type { Cli } from './cf-lanes.ts'

export function registerPaydesk(cf: Command, { root, out }: Cli): void {
  const net: Net = { fetch, resolve: (host) => lookup(host) }
  const paydesk = cf.command('paydesk')
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

function notes(scanFile: string, dir: string, from: string): number {
  const text = readFileSync(scanFile, 'utf8')
  const scanned = (text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter((l) => l.trim() !== '').map((l): unknown => JSON.parse(l))) as Row[]
  mkdirSync(dir, { recursive: true })
  let written = 0
  for (const row of scanned) {
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
  const fixes = merge(checked, JSON.parse(readFileSync(scanFile, 'utf8')) as Row[])
  mkdirSync(dir, { recursive: true })
  for (const fix of fixes) {
    writeFileSync(join(dir, `${String(fix.pr)}.md`), render(fix))
    writeFileSync(join(dir, `${String(fix.pr)}.json`), JSON.stringify(fix, null, 2))
  }
  return fixes
}
