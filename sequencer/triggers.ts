import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { maybe, put } from './workspace.ts'

export const UNRUN = 'no fork workflow runs this change; local checks stand as CI'

const Patterns = z.union([z.string(), z.array(z.string())]).transform((p) => (typeof p === 'string' ? [p] : p)).optional()

const Filter = z.object({
  branches: Patterns, 'branches-ignore': Patterns, tags: Patterns, 'tags-ignore': Patterns, paths: Patterns, 'paths-ignore': Patterns,
}).nullish().transform((f) => f ?? {})

type Filter = z.infer<typeof Filter>

const On = z.object({ on: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]) })

/** Each workflow file's `on` as a map of event to filter; null where the file does not parse or its `on` has no known shape. */
function events(dir: string): [string, Record<string, unknown> | null][] {
  const at = join(dir, '.github/workflows')
  if (!existsSync(at)) return []
  return readdirSync(at).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    const doc = parseDocument(readFileSync(join(at, f), 'utf8'))
    const found = On.safeParse(doc.errors.length === 0 ? doc.toJS() : null)
    if (!found.success) return [f, null]
    const { on } = found.data
    return [f, typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on]
  })
}

/** GitHub's filter patterns: `**` is anything, `*` anything but `/`, a leading `!` excludes, and the last match wins. */
function matched(patterns: string[], value: string): boolean {
  return patterns.reduce((hit, p) => {
    const negated = p.startsWith('!')
    return glob(negated ? p.slice(1) : p, value) ? !negated : hit
  }, false)
}

function glob(pattern: string, value: string): boolean {
  if (/[?+[]/.test(pattern)) return true
  const any = (part: string): string => part.split('*').map((s) => s.replace(/[.^$|(){}\\]/g, '\\$&')).join('[^/]*')
  return new RegExp(`^${pattern.split('**').map(any).join('.*')}$`).test(value)
}

function paths(filter: Filter, touched: string[]): boolean {
  const { paths: only, 'paths-ignore': ignored } = filter
  if (only !== undefined) return touched.some((p) => matched(only, p))
  return ignored === undefined || touched.some((p) => !matched(ignored, p))
}

function pushes(filter: Filter, branch: string, touched: string[]): boolean {
  const { branches, 'branches-ignore': ignored } = filter
  const tagged = filter.tags !== undefined || filter['tags-ignore'] !== undefined
  if (branches === undefined && ignored === undefined && tagged) return false
  const on = branches === undefined ? ignored === undefined || !matched(ignored, branch) : matched(branches, branch)
  return on && paths(filter, touched)
}

/** Whether some workflow runs on a push of `touched` to `branch`, or on the rehearsal pull request carrying them. */
export function fired(dir: string, branch: string, touched: string[]): boolean {
  return events(dir).some(([, on]) => on === null || (['push', 'pull_request'] as const).filter((e) => e in on).some((e) => {
    const filter = Filter.safeParse(on[e])
    if (!filter.success) return true
    return e === 'push' ? pushes(filter.data, branch, touched) : paths(filter.data, touched)
  }))
}

/** The workflow files a push or pull request runs that can also be started by hand. */
export function dispatchable(dir: string): string[] {
  return events(dir).filter(([, on]) => on !== null && 'workflow_dispatch' in on && ('push' in on || 'pull_request' in on)).map(([f]) => f)
}

/** Once per tip: a tick that waits on the dispatched runs starts none again. */
export function started(root: string, plan: number, files: string[], tip: string, start: (file: string) => void): void {
  if (maybe(root, plan, 'ci.dispatched') === tip) return
  for (const file of files) start(file)
  put(root, plan, 'ci.dispatched', tip)
}

export function unrun(db: Db, root: string, plan: number, sha: string): void {
  put(root, plan, 'ci.unrun', sha)
  logged(db, { plan, kind: 'ci.unrun', actor: 'tick', outcome: 'pass', message: UNRUN, pointer: null, run: null })
}
