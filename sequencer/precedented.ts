import { precedentsFor, row } from '../precedents/lookup.ts'
import { filed } from '../precedents/store.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { repoOf } from './ready.ts'
import { named } from './theirs.ts'

/** `precedentsFor` reads the repo's tree over `gh` first, so a repo with no stored row never reaches it. */
export function precedented(db: Db, root: string, plan: PlanRow): string {
  if (internal(plan)) return ''
  const repo = repoOf(db, plan)
  if (repo === null || filed(db, repo).length === 0) return ''
  const rows = precedentsFor(db, repo, named(root, plan.id))
  return rows.length === 0 ? '' : `\n\n## Precedents\n\n${rows.map(row).join('\n')}\n`
}
