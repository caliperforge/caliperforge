import { CHECK } from '../cli/find.ts'
import { CARD } from '../cli/queue.ts'
import { parse } from '../rails/diff.ts'
import type { Db } from '../store/index.ts'
import type { Row } from './card.ts'
import { diffOf, maybe } from './workspace.ts'

const ITEM = /^(?:[-*+]|1[.)]) /
const FIXER = '## Answer from the fixer'
const NAME = /[\w./-]+/g

/** A function declaration, so `CHECKS = [lead]` holds across the import cycle through `cli/queue.ts`. */
export function lead(db: Db, root: string, plan: number): Row {
  const row = db.prepare('SELECT t.part FROM plans p JOIN targets t ON t.id = p.target_id WHERE p.id = ?').get(plan) as
    { part: string } | undefined
  const part = row?.part ?? ''
  const leads = leadsOf(maybe(root, plan, 'ask.md') ?? '')
  const n = String(leads.length)
  if (part === '') {
    return leads.length > 1 ? said(false, `the target claims the whole issue of ${n} leads`) : said(true, `whole issue, ${n} lead(s)`)
  }
  const hit = touched(leads, parse(diffOf(root, plan)).map((f) => f.path))
  return hit.length > 1 ? said(false, `covers ${part} but touches leads ${hit.join(', ')}`) : said(true, `covers ${part}, one of ${n} lead(s)`)
}

function said(ok: boolean, says: string): Row {
  return { check: 'lead', ok, says }
}

function leadsOf(ask: string): string[][] {
  const lines = ask.split('\n')
  const body = lines.slice(lines.findIndex((l) => l.includes(CARD)) + 1)
  const end = body.findIndex((l) => l === CHECK || l.startsWith(FIXER))
  const leads: string[][] = []
  let current: string[] | null = null
  for (const line of end === -1 ? body : body.slice(0, end)) {
    if (ITEM.test(line)) {
      current = [line]
      leads.push(current)
    } else if (/^\S/.test(line)) current = null
    else current?.push(line)
  }
  return leads
}

function touched(leads: string[][], paths: string[]): number[] {
  const names = leads.map((l) => [...new Set((l.join('\n').match(NAME) ?? []).map((n) => n.replace(/\.+$/, '')).filter((n) => /[./]/.test(n)))])
  const shared = new Set(names.flat().filter((n, i, all) => all.indexOf(n) !== i))
  const matches = (name: string): boolean => !shared.has(name) && paths.some((p) => p === name || p.endsWith(`/${name}`))
  return names.flatMap((own, i) => own.some(matches) ? [i + 1] : [])
}
