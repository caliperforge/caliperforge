import { join } from 'node:path'
import type { Board, Gh } from '../rails/ci-green/index.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { owed } from './owed.ts'
import { BOARD } from './push.ts'
import { firstLine } from './unpolled.ts'
import { maybe, planDir, put } from './workspace.ts'

const RUN = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/

type Ran = Board & { url: string }

/**
 * Each run on a landed part's board is logged against it; each plan in `next` gets the owed runs' artifacts in
 * its `artifacts/<run id>/` and every run listed at the end of its ask. Returns each download that failed.
 */
export function relayed(db: Db, root: string, landed: number, part: string, next: number[], gh: Gh): string[] {
  const board = (JSON.parse(maybe(root, landed, BOARD) ?? '[]') as Board[]).filter((r): r is Ran => r.url !== undefined)
  for (const r of board) logged(db, { plan: landed, kind: 'landed.run', actor: 'split', outcome: 'pass', message: r.workflow, pointer: r.url, run: null })
  if (board.length === 0) return []
  const owes = new Set(owed(root, landed).map((o) => o.name))
  const failed: string[] = []
  for (const id of next) {
    const rows = board.map((r) => {
      if (!owes.has(r.workflow)) return `- ${r.workflow} ${r.url}`
      try {
        return `- ${r.workflow} ${r.url}, artifacts in ${download(root, id, r, gh)}`
      } catch (error) {
        logged(db, { plan: landed, kind: 'swallowed', actor: 'split', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
        failed.push(`${r.workflow} artifacts for plan ${String(id)} not downloaded: ${firstLine(error)}`)
        return `- ${r.workflow} ${r.url}, artifacts not downloaded: ${firstLine(error)}`
      }
    })
    put(root, id, 'ask.md', `${(maybe(root, id, 'ask.md') ?? '').trimEnd()}\n\n## Runs on part ${part}'s landed commit\n\n${rows.join('\n')}\n`)
  }
  return failed
}

function download(root: string, plan: number, run: Ran, gh: Gh): string {
  const [, repo, id] = RUN.exec(run.url) ?? []
  if (repo === undefined || id === undefined) throw new Error(`no run id in ${run.url}`)
  const dir = join(planDir(root, plan), 'artifacts', id)
  gh(['run', 'download', id, '--repo', repo, '--dir', dir])
  return dir
}
