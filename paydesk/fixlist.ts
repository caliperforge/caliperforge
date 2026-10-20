import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { parse } from 'yaml'
import type { Row as Scanned } from './prs.ts'

export interface Row { pr: number; listing: string; method?: string; path?: string; msg: string; range?: [number, number]; length?: number }
export interface Item { listing: string; where: string; what: string; blocking: boolean }
export interface Fix { pr: number; items: Item[]; passes: string[] }

const LINE = /^- (\S+): (?:([A-Z]+) (\S+): )?(.*)$/
const RANGES: Record<string, [number, number]> = { summary: [24, 63], description: [64, 255], use_case: [32, 255] }

export function rows(stderr: string, pr: number, root: string): Row[] {
  return stripVTControlCharacters(stderr).split('\n').flatMap((line) => {
    const [, listing = '', method, path, msg = ''] = LINE.exec(line) ?? []
    if (listing === '' || msg.startsWith('PASS')) return []
    return [sized({ pr, listing, ...(method === undefined ? {} : { method }), ...(path === undefined ? {} : { path }), msg }, root)]
  })
}

function sized(row: Row, root: string): Row {
  const found = /length|characters/i.test(row.msg) ? Object.entries(RANGES).find(([f]) => new RegExp(`\\b${f}\\b`, 'i').test(row.msg)) : undefined
  if (found === undefined) return row
  const [field, range] = found
  const front = parse(readFileSync(join(root, row.listing, 'PAY.md'), 'utf8').split(/^---$/m)[1] ?? '') as Record<string, unknown> | null
  const value = front?.[field]
  return { ...row, range, length: typeof value === 'string' ? Array.from(value).length : 0 }
}

const fqnOf = (listing: string): string => listing.split('/').slice(-2).join('/')

export function merge(checked: Row[], scanned: Scanned[]): Fix[] {
  const fixes = new Map<number, Fix>()
  const fix = (pr: number): Fix => {
    const found = fixes.get(pr) ?? { pr, items: [], passes: [] }
    fixes.set(pr, found)
    return found
  }
  for (const r of checked) {
    const what = r.length === undefined ? r.msg : `${r.msg} (now ${String(r.length)})`
    fix(r.pr).items.push({ listing: fqnOf(r.listing), where: r.method === undefined ? 'PAY.md' : `${r.method} ${r.path ?? ''}`, what, blocking: true })
  }
  for (const s of scanned) {
    if ('unfetched' in s) continue
    if ('crash' in s) {
      const prs = new Set(checked.filter((r) => fqnOf(r.listing) === s.fqn).map((r) => r.pr))
      for (const pr of prs) fix(pr).items.push({ listing: s.fqn, where: 'PAY.md', what: `scan crashed: ${s.crash}`, blocking: true })
      continue
    }
    const { items, passes } = fix(s.pr)
    for (const e of s.endpoints) {
      if (e.verdict === 'ok') passes.push(`${s.fqn} ${e.method} ${e.path}`)
      else items.push(...e.issues.map((what) => ({ listing: s.fqn, where: `${e.method} ${e.path}`, what, blocking: e.verdict !== 'warn' && e.verdict !== 'unchecked' })))
    }
  }
  return [...fixes.values()].sort((a, b) => a.pr - b.pr).map((f) => ({ ...f, items: ordered(f.items) }))
}

function ordered(items: Item[]): Item[] {
  const kept = items.filter((it, i) => items.findIndex((o) => o.listing === it.listing && o.where === it.where && o.what === it.what) === i)
  return kept.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.listing.localeCompare(b.listing))
}

export function render({ pr, items, passes }: Fix): string {
  const line = (i: Item): string => `- \`${i.listing}\` ${i.where}: ${i.what}`
  const blocking = items.filter((i) => i.blocking)
  const sections: [string, string[]][] = [
    ['Blocking', blocking.map(line)],
    ['To improve', items.filter((i) => !i.blocking).map(line)],
    ['Passes', passes.map((p) => `- ${p}`)],
  ]
  const heading = `## #${String(pr)}: ${blocking.length === 0 ? 'passes' : `${String(blocking.length)} blocking`}`
  return `${[heading, ...sections.filter(([, lines]) => lines.length > 0).map(([title, lines]) => [`### ${title}`, ...lines].join('\n'))].join('\n\n')}\n`
}
