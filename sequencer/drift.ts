import { join } from 'node:path'
import { z } from 'zod'
import type { Pr } from '../cli/gh.ts'
import { fill } from '../cli/record.ts'
import { holds, newest, setting, stalled, standing, worked } from '../store/drift.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { get, hhmm, set, zone } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { needsCeo, openPipes, planById } from '../store/plans.ts'
import { repos } from '../store/record.ts'
import type { Wire } from './push.ts'
import { cloned, conflicted, drop, maybe, planDir, put, SELF, snapshot } from './workspace.ts'

const IDENT = /^[a-z_]+$/

export const Entry = z.object({
  name: z.string(),
  switch: z.object({ key: z.string(), value: z.string().optional() }).optional(),
  table: z.string().regex(IDENT).optional(),
  column: z.string().regex(IDENT).optional(),
  where: z.string().optional(),
  gap: z.string().regex(/^\d+[hd]$/).optional(),
  while: z.string().optional(),
  when: z.string().optional(),
  expected: z.literal(0).optional(),
})

export type Entry = z.infer<typeof Entry>

export interface Drifted { name: string; state: 'off' | 'silent' | 'stale' | 'seen'; detail: string }

export function drift(db: Db, registry: Entry[], now: Date): Drifted[] {
  return registry.flatMap((entry) => {
    const found = off(db, entry) ?? quiet(db, entry, now)
    return found === null ? [] : [found]
  })
}

function off(db: Db, { name, switch: wanted }: Entry): Drifted | null {
  if (wanted === undefined) return null
  const value = setting(db, wanted.key)
  if (value !== undefined && (wanted.value === undefined ? value !== '' : value === wanted.value)) return null
  return { name, state: 'off', detail: `${wanted.key} is ${value === undefined ? 'unset' : `'${value}'`}` }
}

function quiet(db: Db, entry: Entry, now: Date): Drifted | null {
  const { name, table, column, where, gap, when } = entry
  if (table === undefined || column === undefined) return null
  if (entry.while !== undefined && !holds(db, entry.while)) return null
  const from = `${table}${where === undefined ? '' : ` WHERE ${where}`}`
  const last = newest(db, from, column, now)
  if (entry.expected === 0) {
    return last.days !== null && gap !== undefined && last.days <= days(gap)
      ? { name, state: 'seen', detail: `newest ${table}.${column} is ${String(last.newest)}, within ${gap}; expected none` } : null
  }
  if (last.newest === null) return when === undefined || worked(db, when) ? { name, state: 'silent', detail: `no row in ${from}` } : null
  if (gap === undefined || last.days === null) return null
  return last.days > days(gap) ? { name, state: 'stale', detail: `newest ${table}.${column} is ${String(last.newest)}, older than ${gap}` } : null
}

function days(gap: string): number {
  return Number(gap.slice(0, -1)) / (gap.endsWith('h') ? 24 : 1)
}

interface Spell { step: number; tree: string; since: string; seen: string }

/** `snapshot` stages with `git add -A`, which would mark a stopped merge's conflicts resolved before `conflicted` sees them. */
function treeOf(src: string): string {
  if (!cloned(src)) return 'none'
  return conflicted(src) ? 'conflicted' : snapshot(src)
}

export function stuck(db: Db, root: string, registry: Entry[], now: Date): number[] {
  const gap = registry.find((e) => e.name === 'stuck_plans')?.gap
  if (gap === undefined) return []
  const window = days(gap) * 86_400_000
  return stalled(db, openPipes(db, hhmm(db, now)).map((p) => p.id)).flatMap(({ id, step, wait_reason, waits_on, last }) => {
    if (holder(db, id, now) !== null) return []
    const tree = treeOf(join(planDir(root, id), 'src'))
    const saved = maybe(root, id, 'stuck.json')
    const was = saved === null ? null : JSON.parse(saved) as Spell
    const same = was !== null && was.step === step && was.tree === tree && now.getTime() - Date.parse(was.seen) <= window
    const since = same ? was.since : now.toISOString()
    const spent = now.getTime() - Date.parse(since)
    if (spent < window) {
      put(root, id, 'stuck.json', JSON.stringify({ step, tree, since, seen: now.toISOString() }))
      return []
    }
    const note = `step ${String(step)} and its tree unchanged for ${String(Math.floor(spent / 60_000))} min while the tick ran; ` +
      `waits: ${wait_reason ?? 'none'}${waits_on === null ? '' : ` on plan ${String(waits_on)}`}; last: ${last ?? 'none'}`
    put(root, id, 'refusal.md', `${maybe(root, id, 'refusal.md') ?? ''}\n# Stopped\n\n${note}.\n`)
    needsCeo(db, planById(db, id), note)
    logged(db, { plan: id, kind: 'stuck', actor: 'drift', outcome: 'needs_ceo', message: note, pointer: `step-${String(step)}`, run: null })
    drop(root, id, 'stuck.json')
    return [id]
  })
}

const CAP = 3

export function filed(db: Db, drifted: Drifted[], wire: Pick<Wire, 'file'>, now: Date): string[] {
  const fresh = drifted.map((d) => ({ ...d, title: `Drift: ${d.name} is ${d.state}` })).filter((d) => !standing(db, SELF, d.title, now))
  for (const { title } of fresh.slice(CAP)) {
    logged(db, { plan: null, kind: 'drift_capped', actor: 'drift', outcome: 'refuse', message: title, pointer: null, run: null }, now.toISOString())
  }
  return fresh.slice(0, CAP).map(({ name, state, detail, title }) => {
    const body = [`**What:** ${name} is ${state}: ${detail}`,
      `**Why:** rules/registry.yaml lists ${name} as a mechanism that runs`,
      `**When it ends:** drift no longer reports ${name}`, ''].join('\n')
    return wire.file(SELF, title, body, ['lane:machine', 'P1', 'drift'])
  })
}

export function due(db: Db, registry: Entry[], now: Date, wire: Pick<Wire, 'file'>,
  read: (repo: string, no: number) => Pr): string[] {
  if (hhmm(db, now) < '05:30') return []
  const day = new Date(now.getTime() + zone(db) * 60000).toISOString().slice(0, 10)
  if (day <= get(db, 'drift.at')) return []
  set(db, 'drift.at', day, 'pr', now.toISOString())
  for (const repo of repos(db)) fill(db, repo, read)
  return filed(db, drift(db, registry, now), wire, now)
}
