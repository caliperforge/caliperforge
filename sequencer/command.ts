import { parseDocument } from 'yaml'
import { z } from 'zod'
import { refile } from '../cli/refile.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { put } from './workspace.ts'

const ALLOWED = /^cf gh refile (\S+) (\S+)$/

const Command = z.object({ outcome: z.literal('command'), run: z.string().min(1) })

export function commanded(reply: string): string | null {
  const fence = /(?:^|\n)---\r?\n([\s\S]*?)\r?\n---\s*(?:```\s*)?$/.exec(reply.trimEnd())?.[1]
  const doc = fence === undefined ? null : parseDocument(fence)
  if (doc === null || doc.errors.length > 0) return null
  const parsed = Command.safeParse(doc.toJS())
  return parsed.success ? parsed.data.run.trim() : null
}

/** Runs an allow-listed command in place of a build; `command.md` keeps the line and what it said. */
export function executed(db: Db, root: string, plan: PlanRow, line: string): Outcome {
  const hit = ALLOWED.exec(line)
  if (hit === null) return { outcome: 'refuse', spans: ['command'], note: `${line} is not on the allow-list` }
  try {
    const output = refile(db, String(hit[1]), String(hit[2]))
    put(root, plan.id, 'command.md', `${line}\n\n${output}\n`)
    return { outcome: 'pass', spans: [], ran: true, note: `${line}: ${output}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    put(root, plan.id, 'command.md', `${line}\n\n${message}\n`)
    logged(db, { plan: plan.id, kind: 'command', actor: 'command', outcome: 'escalate', message, pointer: 'command.md', run: null })
    return { outcome: 'needs_ceo', spans: ['command'], note: `command: ${message.split('\n')[0] ?? ''}` }
  }
}
