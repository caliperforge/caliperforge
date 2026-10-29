import { gh, type Read } from '../cli/gh.ts'
import { issue } from '../cli/plan.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { originRef, type PlanRow } from '../store/plans.ts'
import { drop, maybe, put } from './workspace.ts'

const APPENDED = /^(?:## Answer from the |## Parent comments|Fork: )/m

export function reread(db: Db, root: string, plan: PlanRow, actor: string, read: Read = gh): void {
  const ref = originRef(plan)
  const ask = maybe(root, plan.id, 'ask.md')
  if (ref === null || ask === null) return
  const row = issue(ref.repo, ref.no, read)
  const text = `# ${row.title}\n\n${row.body}\n`
  const at = ask.search(APPENDED)
  const old = at === -1 ? ask : ask.slice(0, at)
  if (old.trimEnd() === text.trimEnd()) return
  const briefed = maybe(root, plan.id, 'issue.md')
  const answers = (briefed ?? '').split(/^(?=## )/m).filter((s) => s.startsWith('## Answer from the '))
  put(root, plan.id, 'ask.md', [text, at === -1 ? '' : ask.slice(at), ...answers].filter((s) => s !== '').join('\n'))
  drop(root, plan.id, 'issue.md')
  drop(root, plan.id, 'ask.briefed.md')
  const message = `${ref.repo}#${String(ref.no)} changed: ask.md rewritten${briefed === null ? '' : ', issue.md dropped'}`
  logged(db, { plan: plan.id, kind: 'refresh', actor, outcome: 'pass', message, pointer: null, run: null })
}
