import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logged } from '../store/events.ts'
import { edit, filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { builderRan, type PlanRow } from '../store/plans.ts'
import { unruled } from './unruled.ts'
import { get, headSha, maybe, put, srcDir } from './workspace.ts'

const PATH = /(?:^|[\s`'"(])(~?\/[^\s`'"()]+)/g

const OUTSIDE = /^ {2}- (\S+):1 authority\.outside_files$/gm

export function opened(db: Db, root: string, plan: number): string[] {
  const tokens = [...(maybe(root, plan, 'rulings.md') ?? '').matchAll(/`([^`\s]+)`/g)]
    .map((m) => (m[1] ?? '').replace(/:\d+(?:-\d+)?$/, '')).filter((t) => t.includes('/') || /\.\w+$/.test(t))
  const listed = new Set(filesOf(db, plan).map((f) => f.path))
  const missed: string[] = []
  for (const t of new Set(tokens)) {
    if (t.includes('..') || statSync(join(srcDir(root, plan), t), { throwIfNoEntry: false })?.isFile() !== true) missed.push(t)
    else if (!listed.has(t)) edit(db, plan, 'add', t, 'ruling', 'named in rulings.md')
  }
  if (missed.length > 0) logged(db, { plan, kind: 'files', actor: 'ruling', outcome: 'refuse', message: `not in the checkout: ${missed.join(', ')}`, pointer: null, run: null })
  return missed
}

export function rule(db: Db, root: string, plan: PlanRow, who: string, text: string): 'ask.md' | 'issue.md' | null {
  const other = [...text.matchAll(/\.cf\/work\/(\d+)/g)].some((m) => Number(m[1]) !== plan.id)
  if (other || /(?:^|[^.])\.\.\//.test(text)) return null
  if ([...text.matchAll(PATH)].some((m) => !(m[1] ?? '').startsWith(`${root}/`))) return null
  const section = `## Answer from the ${who} (${new Date().toISOString().slice(0, 10)})\n\n${text.trim()}\n`
  if (!builderRan(db, plan.id)) {
    put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}\n${section}`)
    return 'ask.md'
  }
  put(root, plan.id, 'issue.md', above(maybe(root, plan.id, 'issue.md') ?? '', section))
  return 'issue.md'
}

/** A ruling on a Greptile stop at ready accepts the findings still open at the head. */
export function accepted(root: string, plan: PlanRow, answer: string): boolean {
  const text = maybe(root, plan.id, 'refusal.md') ?? ''
  if (!text.startsWith(`step ${String(plan.step)} ready `) || !/^ {2}- greptile:\d\/5$/m.test(text)) return false
  const sha = headSha(srcDir(root, plan.id))
  const { open } = unruled(root, plan.id, sha)
  if (open.length === 0) return false
  put(root, plan.id, 'rulings.md', `${maybe(root, plan.id, 'rulings.md') ?? ''}\naccepted:\n  head: ${sha.slice(0, 12)}\n  ids: ${
    open.join(', ')}\n  reason: ${answer.replace(/\s+/g, ' ').trim()}\n`)
  return true
}

/** Each path refused as outside the files that `answer` names gets a row under the brief's `## Outside the files`. */
export function owned(root: string, plan: PlanRow, answer: string): boolean {
  const why = answer.replace(/\s+/g, ' ').trim()
  const words = new Set(answer.split(/[^\w./-]+/).map((w) => w.replace(/\.+$/, '')))
  const rows = [...railed(root, plan).matchAll(OUTSIDE)]
    .flatMap((m) => words.has(m[1] ?? '') ? [`- \`${m[1] ?? ''}\` — ${why}`] : [])
  if (rows.length === 0) return false
  const issue = get(root, plan.id, 'issue.md')
  const lines = issue.split('\n')
  const head = lines.findIndex((l) => l.trimEnd() === '## Outside the files')
  if (head === -1) {
    put(root, plan.id, 'issue.md', above(issue, `## Outside the files\n\n${rows.join('\n')}\n`))
    return true
  }
  const next = lines.findIndex((l, i) => i > head && l.startsWith('## '))
  let end = next === -1 ? lines.length : next
  while (end > head + 1 && lines[end - 1]?.trim() === '') end -= 1
  put(root, plan.id, 'issue.md', [...lines.slice(0, end), ...rows, ...lines.slice(end)].join('\n'))
  return true
}

export function fenced(root: string, plan: PlanRow): boolean {
  return /^ {2}- \S+ authority\./m.test(railed(root, plan))
}

/** `refusal.md` outlives the stop that wrote it, so it counts only while the plan still stands on that step-3 refusal. */
function railed(root: string, plan: PlanRow): string {
  const text = maybe(root, plan.id, 'refusal.md') ?? ''
  return plan.step === 3 && text.startsWith('step 3 ') ? text : ''
}

function above(issue: string, section: string): string {
  const lines = issue.split('\n')
  const at = lines.indexOf('## Standing')
  return at === -1 ? `${issue}\n${section}` : [...lines.slice(0, at), section, ...lines.slice(at)].join('\n')
}
