import { gh, type Read } from '../cli/gh.ts'
import { precedentsFor, row } from '../precedents/lookup.ts'
import { filed } from '../precedents/store.ts'
import type { Bench } from '../runner/packet.ts'
import { filesOf } from '../store/files.ts'
import type { Db } from '../store/index.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import { repoOf } from './ready.ts'
import { named } from './theirs.ts'

export function precedented(db: Db, root: string, plan: PlanRow): string {
  const repo = stored(db, plan)
  const rows = repo === null ? [] : precedentsFor(db, repo, named(root, plan.id))
  return rows.length === 0 ? '' : `\n\n## Precedents\n\n${rows.map(row).join('\n')}\n`
}

export function reviewed(db: Db, plan: PlanRow, read: Read = gh): Pick<Bench, 'precedents'> {
  const repo = stored(db, plan)
  const rows = repo === null ? [] : precedentsFor(db, repo, filesOf(db, plan.id).map((f) => f.path), read)
  return rows.length === 0 ? {} : { precedents: rows }
}

/** `precedentsFor` reads the repo's tree over `gh` first, so a repo with no stored row never reaches it. */
function stored(db: Db, plan: PlanRow): string | null {
  const repo = internal(plan) ? null : repoOf(db, plan)
  return repo === null || filed(db, repo).length === 0 ? null : repo
}
