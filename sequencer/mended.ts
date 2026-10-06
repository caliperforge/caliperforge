import { z } from 'zod'
import { WINDOW, type Read } from '../cli/gh.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { end, originRef, type PlanRow } from '../store/plans.ts'
import { firstLine } from './unpolled.ts'
import { OPERATOR } from './workspace.ts'

const Thread = z.object({
  state: z.string(),
  comments: z.array(z.object({ body: z.string(), author: z.object({ login: z.string() }).nullish() })),
})

const Merged = z.array(z.object({ url: z.string(), title: z.string(), body: z.string() }))

const Pull = z.object({ url: z.string(), mergedAt: z.string().nullable() })

/** A queued plan whose closed issue a merged pull request fixed by hand is done; a read that throws leaves it queued. */
export function mended(db: Db, plan: PlanRow, read: Read, lines: string[]): void {
  try {
    const url = fix(plan, read)
    if (url === null) {
      end(db, plan.id, 'halted', `${plan.origin ?? ''} is closed or has lost its lane label`)
      return
    }
    end(db, plan.id, 'done')
    logged(db, { plan: plan.id, kind: 'close', actor: 'tick', outcome: 'pass', message: `fixed by ${url}`, pointer: url, run: null })
  } catch (error) {
    logged(db, { plan: plan.id, kind: 'swallowed', actor: 'halt', outcome: 'pass', message: firstLine(error), pointer: plan.origin, run: null })
    lines.push(`${plan.origin ?? ''}: ${firstLine(error)}`)
  }
}

function fix(plan: PlanRow, read: Read): string | null {
  const ref = originRef(plan)
  if (ref === null) return null
  const { repo, no } = ref
  const issue = Thread.parse(read(['issue', 'view', String(no), '--repo', repo, '--json', 'state,comments']))
  if (issue.state === 'OPEN') return null
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\\s+#${String(no)}(?!\\d)`, 'i')
  const merged = Merged.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `#${String(no)}`,
    '--limit', String(WINDOW), '--json', 'number,url,title,body'])).find((p) => closes.test(`${p.title}\n${p.body}`))
  if (merged !== undefined) return merged.url
  const pull = new RegExp(`https://github\\.com/${repo.replaceAll('.', '\\.')}/pull/(\\d+)`)
  const named = issue.comments.filter((c) => c.author?.login === OPERATOR).map((c) => pull.exec(c.body)?.[1]).filter((n) => n !== undefined).at(-1)
  if (named === undefined) return null
  const view = Pull.parse(read(['pr', 'view', named, '--repo', repo, '--json', 'url,mergedAt']))
  return view.mergedAt === null ? null : view.url
}
