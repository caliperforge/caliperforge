import { z } from 'zod'
import { gh, trunk, type Read } from '../cli/gh.ts'
import type { Db } from '../store/index.ts'
import { filed, type Precedent } from './store.ts'

const Tree = z.object({ tree: z.array(z.object({ path: z.string() })), truncated: z.boolean() })

const fileOf = (area: string): string => area.replace(/:.*/s, '')

export function precedentsFor(db: Db, repo: string, files: string[], read: Read = gh): Precedent[] {
  const { tree, truncated } = Tree.parse(read(['api', `repos/${repo}/git/trees/${trunk(repo, read)}?recursive=1`]))
  if (truncated) throw new Error(`${repo} tree is truncated; stale precedents cannot be told`)
  const paths = new Set(tree.map((t) => t.path))
  const bare = (area: string): number => Number(!(area.includes(':') && files.includes(fileOf(area))))
  return filed(db, repo)
    .filter((p) => paths.has(fileOf(p.area)) && (files.includes(fileOf(p.area)) || p.files.some((f) => files.includes(f))))
    .sort((a, b) => Number(a.role !== 'maintainer') - Number(b.role !== 'maintainer') || bare(a.area) - bare(b.area)
      || b.merged_at.localeCompare(a.merged_at))
    .slice(0, 5)
    .map(({ area, decision, why, said_by, role, source }) => ({ area, decision, why, said_by, role, source }))
}

export const row = (p: Precedent): string =>
  `- area: ${p.area} | decision: ${p.decision} | why: ${p.why} | said_by: ${p.said_by} (${p.role}) | source: ${p.source}`
