import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { gh, outside, type Pr, type Read } from '../cli/gh.ts'
import { fill } from '../cli/record.ts'
import { addFinding, answered, closeFinding, holds, newest, setting, stalled, unclosed, worked } from '../store/drift.ts'
import { logged, returns } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { get, hhmm, set, zone } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { needsCeo, openPipes, planById, rewind } from '../store/plans.ts'
import { added, registry } from './registry.ts'
import { HELD } from './settle.ts'
import { cloned, conflicted, drop, maybe, planDir, put, snapshot } from './workspace.ts'

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

export type Entry = z.infer<typeof Entry> & { added?: string | undefined }

export function mechanisms(root: string, at?: string): Entry[] {
  const seed = added(root, at)
  return registry(root, at).flatMap(({ path, text }) => Entry.array().parse(parse(text)).map((entry) => ({ ...entry, added: seed.get(path) })))
}

export interface Drifted { name: string; state: 'off' | 'silent' | 'stale' | 'seen'; detail: string; newest?: string | number | null }

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
  const since = new Date(now.getTime() - days(gap ?? '7d') * 86_400_000).toISOString()
  if (entry.while !== undefined && !holds(db, entry.while, since)) return null
  const from = `${table}${where === undefined ? '' : ` WHERE ${where}`}`
  const last = newest(db, from, column, now)
  if (entry.expected === 0) {
    return last.days !== null && gap !== undefined && last.days <= days(gap)
      ? { name, state: 'seen', detail: `newest ${table}.${column} is ${String(last.newest)}, within ${gap}; expected none`, newest: last.newest } : null
  }
  if (last.newest === null && entry.added !== undefined && entry.added > since) return null
  if (last.newest === null) return when === undefined || worked(db, when, since) ? { name, state: 'silent', detail: `no row in ${from}` } : null
  if (gap === undefined || last.days === null) return null
  return last.days > days(gap) ? { name, state: 'stale', detail: `newest ${table}.${column} is ${String(last.newest)}, older than ${gap}`, newest: last.newest } : null
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
    if (holder(db, id, now) !== null || last?.endsWith(HELD) === true) return []
    if (planById(db, id).template === 'pr_path' && step > 1 && maybe(root, id, 'issue.md') === null) {
      rewind(db, id, 1)
      drop(root, id, 'stuck.json')
      const note = `step ${String(step)} has no issue.md to work from; back to the brief`
      logged(db, { plan: id, kind: 'stuck', actor: 'drift', outcome: 'pass', message: note, pointer: `step-${String(step)}`, run: null })
      return []
    }
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
    const pointer = `step-${String(step)} ${tree}`
    const back = returns(db, id, pointer)
    const circled = back.length < 2 ? ''
      : `the director returned step ${String(step)} on tree ${tree} ${String(back.length)} times; last reason: ${back.at(-1)?.split('\n')[0] ?? ''}; `
    const note = `${circled}step ${String(step)} and its tree unchanged for ${String(Math.floor(spent / 60_000))} min while the tick ran; ` +
      `waits: ${wait_reason ?? 'none'}${waits_on === null ? '' : ` on plan ${String(waits_on)}`}; last: ${last ?? 'none'}`
    put(root, id, 'refusal.md', `${maybe(root, id, 'refusal.md') ?? ''}\n# Stopped\n\n${note}.\n`)
    needsCeo(db, planById(db, id), note)
    logged(db, { plan: id, kind: 'stuck', actor: 'drift', outcome: circled === '' ? 'escalate' : 'needs_coo', message: note, pointer, run: null })
    drop(root, id, 'stuck.json')
    return [id]
  })
}

export function recorded(db: Db, drifted: Drifted[], now: Date): number[] {
  return drifted.flatMap(({ name, state, detail, newest: last }) => {
    const id = answered(db, name, detail, last) ? null : addFinding(db, { name, state, detail }, now)
    return id === null ? [] : [id]
  })
}

export function recovered(db: Db, registry: Entry[], drifted: Drifted[], now: Date): number[] {
  return unclosed(db).flatMap((found) => {
    const entry = registry.find((e) => e.name === found.name)
    const line = entry === undefined || drifted.some((d) => d.name === found.name) ? null : why(db, entry, found.state, now)
    if (line === null) return []
    closeFinding(db, found.id, 'fixed', line, null, now)
    logged(db, { plan: null, kind: 'drift', actor: 'drift', outcome: 'pass', message: `recovered finding ${String(found.id)} ${found.name}`,
      pointer: null, run: null }, now.toISOString())
    return [found.id]
  })
}

function why(db: Db, { switch: wanted, table, column, where }: Entry, state: Drifted['state'], now: Date): string | null {
  if (state === 'off' && wanted !== undefined) return `recovered: ${wanted.key} is '${String(setting(db, wanted.key))}'`
  if (table === undefined || column === undefined) return null
  const last = newest(db, `${table}${where === undefined ? '' : ` WHERE ${where}`}`, column, now)
  return `recovered: newest ${table}.${column} is ${String(last.newest)}`
}

export function due(db: Db, registry: Entry[], now: Date, read: (repo: string, no: number) => Pr, search: Read = gh): number[] {
  if (hhmm(db, now) < '05:30') return []
  const day = new Date(now.getTime() + zone(db) * 60000).toISOString().slice(0, 10)
  if (day <= get(db, 'drift.at')) return []
  set(db, 'drift.at', day, 'pr', now.toISOString())
  fill(db, null, read, outside(search), () => null)
  const drifted = drift(db, registry, now)
  const added = recorded(db, drifted, now)
  recovered(db, registry, drifted, now)
  return added
}
