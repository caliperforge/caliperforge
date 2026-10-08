import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { ours, WINDOW, type Read } from '../cli/gh.ts'
import { CARD } from '../cli/queue.ts'
import { parse } from '../rails/diff.ts'
import { internal, type PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { headOf } from './push.ts'
import { diffOf, git, maybe } from './workspace.ts'

const Prs = z.array(z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  files: z.array(z.object({ path: z.string() })),
}))

/** Our other open pull requests on a file the job changes merge clean with its head, or the card names the one it stacks on. */
export function stacked(root: string, plan: PlanRow, repo: string, read: Read): Outcome | null {
  if (internal(plan)) return null
  const { dir, branch } = headOf(root, plan.id)
  const paths = parse(diffOf(root, plan.id)).map((f) => f.path)
  const base = baseOf(maybe(root, plan.id, 'ask.md') ?? '')
  const hits = Prs.parse(read(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(WINDOW),
    '--json', 'number,url,headRefName,headRepositoryOwner,files']))
    .filter((p) => ours(p.headRepositoryOwner?.login) && p.headRefName !== branch && p.number !== base
      && p.files.some((f) => paths.includes(f.path)))
    .flatMap((p) => {
      const conflicted = conflicts(dir, p.headRefName, p.number)
      return conflicted.length === 0 ? [] : [{ url: p.url, paths: conflicted }]
    })
  if (hits.length === 0) return null
  return { outcome: 'refuse', to: 2, spans: hits.flatMap((h) => [h.url, ...h.paths]),
    note: `${hits.map((h) => `${h.url} conflicts on ${h.paths.join(', ')}`).join('; ')}; merge clean with it, or the card names it as \`Stacks on #<n>\`` }
}

function baseOf(ask: string): number | null {
  const at = ask.indexOf(CARD)
  const no = at < 0 ? undefined : /^Stacks on #(\d+)\b/m.exec(ask.slice(0, at))?.[1]
  return no === undefined ? null : Number(no)
}

function conflicts(dir: string, branch: string, no: number): string[] {
  const ref = `refs/stack/${String(no)}`
  git(dir, ['fetch', '--no-tags', 'origin', `+${branch}:${ref}`])
  const run = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', ref], { cwd: dir, encoding: 'utf8' })
  if (run.status === 0) return []
  if (run.status === 1) return run.stdout.split('\n').slice(1).filter((l) => l !== '')
  throw new Error(`git merge-tree HEAD ${ref} exited ${String(run.status)}: ${run.stderr}`)
}
