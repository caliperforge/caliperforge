import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { PlanFile } from '../store/files.ts'

const PARTS = ['**What:**', '**Why:**', '**When it ends:**',
  '## Approach', '## Cases', '## Must not break', '## Files', '## Out of scope']

const CEILING = 60

const PATH = /^\s*[-*]\s*`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::\d+)?`?/

const ROW = /^\s*[-*]\s*\**D\d+\**/gm

const Unclear = z.object({ outcome: z.literal('unclear'), question: z.string().min(1) })

/** The fence a seat ends with when the ask cannot be briefed against the code: the question goes back to the COO. */
export function unclear(reply: string): string | null {
  const fence = /---\r?\n([\s\S]*?)\r?\n---$/.exec(reply.trimEnd())
  if (fence === null) return null
  const parsed = Unclear.safeParse(yamlOf(fence[1] ?? ''))
  return parsed.success ? parsed.data.question : null
}

/** The part of the brief that is missing, out of order or untrue of the checkout; null is a brief a builder can work from. */
export function shape(brief: string, ask: string, src: string): string | null {
  const title = titleOf(brief)
  if (title === null || title !== titleOf(ask)) return '# <title>'
  const part = order(brief)
  if (part !== null) return part
  if ((section(brief, '## Cases').match(ROW) ?? []).length < 2) return '## Cases'
  if (brief.trimEnd().split('\n').length > CEILING) return `${String(CEILING)} lines`
  return absent(brief, src)
}

function order(brief: string): string | null {
  const lines = brief.split('\n').map((l) => l.trim())
  let at = 0
  for (const part of PARTS) {
    const found = lines.findIndex((l, i) => i >= at && l.startsWith(part))
    if (found === -1) return part
    at = found + 1
  }
  return null
}

/** The one reader of `## Files`: every path the brief says the job touches, in the order it listed them. */
export function files(brief: string): PlanFile[] {
  return section(brief, '## Files').split('\n').flatMap((line): PlanFile[] => {
    const path = PATH.exec(line)?.[1]
    return path === undefined ? [] : [{ path, is_new: line.includes('(new)') }]
  })
}

function absent(brief: string, src: string): string | null {
  for (const file of files(brief)) {
    if (!file.is_new && !existsSync(join(src, file.path))) return file.path
  }
  return null
}

function section(brief: string, heading: string): string {
  const lines = brief.split('\n')
  const from = lines.findIndex((l) => l.trimEnd() === heading)
  if (from === -1) return ''
  const rest = lines.slice(from + 1)
  const to = rest.findIndex((l) => l.startsWith('## '))
  return (to === -1 ? rest : rest.slice(0, to)).join('\n')
}

function titleOf(text: string): string | null {
  return /^#\s+(.*)$/m.exec(text)?.[1]?.trim() ?? null
}

function yamlOf(text: string): unknown {
  try {
    return parse(text)
  } catch {
    return null
  }
}
