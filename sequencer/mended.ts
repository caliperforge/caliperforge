import { z } from 'zod'
import { WINDOW, type Read } from '../cli/gh.ts'
import { eventsOf, logged } from '../store/events.ts'
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

/** A queued plan whose closed issue a merged pull request fixed by hand is done; an open issue or a read that throws leaves it queued. */
export function mended(db: Db, plan: PlanRow, read: Read, lines: string[]): void {
  try {
    const ref = originRef(plan)
    const issue = ref === null ? null : Thread.parse(read(['issue', 'view', String(ref.no), '--repo', ref.repo, '--json', 'state,comments']))
    if (issue?.state === 'OPEN') {
      raced(db, plan, lines)
      return
    }
    const url = ref === null || issue === null ? null : fix(issue, ref, read)
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

function raced(db: Db, plan: PlanRow, lines: string[]): void {
  const line = `${plan.origin ?? ''} reads open but is not in its lane's list yet; left queued`
  if (eventsOf(db, plan.id, 'swallowed').some((e) => e.message === line)) return
  logged(db, { plan: plan.id, kind: 'swallowed', actor: 'halt', outcome: 'pass', message: line, pointer: plan.origin, run: null })
  lines.push(line)
}

function fix(issue: z.infer<typeof Thread>, { repo, no }: { repo: string; no: number }, read: Read): string | null {
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
