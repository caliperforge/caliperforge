import type { Db } from '../store/index.ts'
import { builderRan, type PlanRow } from '../store/plans.ts'
import { get, maybe, put } from './workspace.ts'

const PATH = /(?:^|[\s`'"(])(~?\/[^\s`'"()]+)/g

const OUTSIDE = /^ {2}- (\S+):1 authority\.outside_files$/gm

export function rule(db: Db, root: string, plan: PlanRow, who: string, text: string): 'ask.md' | 'issue.md' | null {
  const other = [...text.matchAll(/\.cf\/work\/(\d+)/g)].some((m) => Number(m[1]) !== plan.id)
  if (other || /(?:^|[^.])\.\.\//.test(text)) return null
  if ([...text.matchAll(PATH)].some((m) => !(m[1] ?? '').startsWith(`${root}/`))) return null
  const section = `## Answer from the ${who} (${new Date().toISOString().slice(0, 10)})\n\n${text.trim()}\n`
  if (!builderRan(db, plan.id)) {
    put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}\n${section}`)
    return 'ask.md'
  }
  put(root, plan.id, 'issue.md', above(get(root, plan.id, 'issue.md'), section))
  return 'issue.md'
}

/** Each path refused as outside the files that `answer` names gets a row under the brief's `## Outside the files`. */
export function owned(root: string, plan: PlanRow, answer: string): boolean {
  const why = answer.replace(/\s+/g, ' ').trim()
  const rows = [...(maybe(root, plan.id, 'refusal.md') ?? '').matchAll(OUTSIDE)]
    .flatMap((m) => answer.includes(m[1] ?? '') ? [`- \`${m[1] ?? ''}\` — ${why}`] : [])
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
  return /^ {2}- \S+ authority\./m.test(maybe(root, plan.id, 'refusal.md') ?? '')
}

function above(issue: string, section: string): string {
  const lines = issue.split('\n')
  const at = lines.indexOf('## Standing')
  return at === -1 ? `${issue}\n${section}` : [...lines.slice(0, at), section, ...lines.slice(at)].join('\n')
}
