import type { Db } from '../store/index.ts'
import { builderRan, type PlanRow } from '../store/plans.ts'
import { get, maybe, put } from './workspace.ts'

const PATH = /(?:^|[\s`'"(])(~?\/[^\s`'"()]+)/g

export function rule(db: Db, root: string, plan: PlanRow, who: string, text: string): 'ask.md' | 'issue.md' | null {
  if (text.includes('.cf/work/') || text.includes('../')) return null
  if ([...text.matchAll(PATH)].some((m) => !(m[1] ?? '').startsWith(`${root}/`))) return null
  const section = `## Answer from the ${who} (${new Date().toISOString().slice(0, 10)})\n\n${text.trim()}\n`
  if (!builderRan(db, plan.id)) {
    put(root, plan.id, 'ask.md', `${maybe(root, plan.id, 'ask.md') ?? ''}\n${section}`)
    return 'ask.md'
  }
  const issue = get(root, plan.id, 'issue.md')
  const lines = issue.split('\n')
  const at = lines.indexOf('## Standing')
  put(root, plan.id, 'issue.md', at === -1 ? `${issue}\n${section}` : [...lines.slice(0, at), section, ...lines.slice(at)].join('\n'))
  return 'issue.md'
}
