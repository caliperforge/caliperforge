import { execFileSync } from 'node:child_process'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { refile } from '../cli/refile.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { PlanRow } from '../store/plans.ts'
import type { Outcome } from './kind.ts'
import { maybe, put } from './workspace.ts'

const REFILE = /^cf gh refile (\S+) (\S+)$/
const TOOL = /^node tools\/([a-z0-9-]+)\/run\.ts (https?:\/\/\S+) --out (\.cf\/\1\/[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/

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
  const command = allowed(db, root, line)
  if (command === null) return { outcome: 'refuse', spans: ['command'], note: `${line} is not on the allow-list` }
  if (TOOL.test(line) && !(maybe(root, plan.id, 'ask.md') ?? '').includes(line)) return { outcome: 'refuse', spans: ['command'], note: `${line} is not in the ask` }
  try {
    const output = command()
    put(root, plan.id, 'command.md', `${line}\n\n${output}\n`)
    return { outcome: 'pass', spans: [], ran: true, note: `${line}: ${output}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    put(root, plan.id, 'command.md', `${line}\n\n${message}\n`)
    logged(db, { plan: plan.id, kind: 'command', actor: 'command', outcome: 'escalate', message, pointer: 'command.md', run: null })
    return { outcome: 'needs_ceo', spans: ['command'], note: `command: ${message.split('\n')[0] ?? ''}` }
  }
}

function allowed(db: Db, root: string, line: string): (() => string) | null {
  const refiled = REFILE.exec(line)
  if (refiled !== null) return () => refile(db, String(refiled[1]), String(refiled[2]))
  const tool = TOOL.exec(line)
  if (tool === null) return null
  return () => execFileSync('node', [`tools/${String(tool[1])}/run.ts`, String(tool[2]), '--out', String(tool[3])],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
