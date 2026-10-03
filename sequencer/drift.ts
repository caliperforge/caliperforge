import { z } from 'zod'
import type { Db } from '../store/index.ts'
import type { Wire } from './push.ts'
import { SELF } from './workspace.ts'

const IDENT = /^[a-z_]+$/

export const Entry = z.object({
  name: z.string(),
  switch: z.object({ key: z.string(), value: z.string().optional() }).optional(),
  table: z.string().regex(IDENT).optional(),
  column: z.string().regex(IDENT).optional(),
  where: z.string().optional(),
  gap: z.string().regex(/^\d+[hd]$/).optional(),
  while: z.string().optional(),
})

export type Entry = z.infer<typeof Entry>

export interface Drifted { name: string; state: 'off' | 'silent' | 'stale'; detail: string }

export function drift(db: Db, registry: Entry[], now: Date): Drifted[] {
  return registry.flatMap((entry) => {
    const found = off(db, entry) ?? quiet(db, entry, now)
    return found === null ? [] : [found]
  })
}

function off(db: Db, { name, switch: wanted }: Entry): Drifted | null {
  if (wanted === undefined) return null
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(wanted.key) as { value: string } | undefined
  if (row !== undefined && (wanted.value === undefined ? row.value !== '' : row.value === wanted.value)) return null
  return { name, state: 'off', detail: `${wanted.key} is ${row === undefined ? 'unset' : `'${row.value}'`}` }
}

function quiet(db: Db, entry: Entry, now: Date): Drifted | null {
  const { name, table, column, where, gap } = entry
  if (table === undefined || column === undefined) return null
  if (entry.while !== undefined && (db.prepare(`SELECT (${entry.while}) AS on_`).get() as { on_: number }).on_ !== 1) return null
  const from = `${table}${where === undefined ? '' : ` WHERE ${where}`}`
  const { newest } = db.prepare(`SELECT max(${column}) AS newest FROM ${from}`).get() as { newest: string | number | null }
  if (newest === null) return { name, state: 'silent', detail: `no row in ${from}` }
  if (gap === undefined) return null
  const { days } = db.prepare('SELECT julianday(?) - julianday(?) AS days').get(now.toISOString(), newest) as { days: number }
  const limit = Number(gap.slice(0, -1)) / (gap.endsWith('h') ? 24 : 1)
  return days > limit ? { name, state: 'stale', detail: `newest ${table}.${column} is ${String(newest)}, older than ${gap}` } : null
}

export function filed(db: Db, drifted: Drifted[], wire: Pick<Wire, 'file'>): string[] {
  const open = db.prepare('SELECT 1 FROM tickets WHERE repo = ? AND title = ? AND closed_at IS NULL')
  return drifted.flatMap(({ name, state, detail }) => {
    const title = `Drift: ${name} is ${state}`
    if (open.get(SELF, title) !== undefined) return []
    const body = [`**What:** ${name} is ${state}: ${detail}`,
      `**Why:** rules/registry.yaml lists ${name} as a mechanism that runs`,
      `**When it ends:** drift no longer reports ${name}`, ''].join('\n')
    return [wire.file(SELF, title, body, ['lane:machine', 'P1', 'drift'])]
  })
}
