import { z } from 'zod'
import { WINDOW, type Read } from '../cli/gh.ts'
import { logins, p50 } from '../cli/measure.ts'
import type { Check } from './card.ts'

const Merged = z.array(z.object({
  author: z.object({ login: z.string() }).nullable(),
  mergedBy: z.object({ login: z.string() }).nullable(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
}))

const DAYS = 30

const DAY = 86400000

export function merging(repo: string, read: Read, now: Date = new Date()): Check {
  return () => {
    const took = outside(Merged.parse(read(['pr', 'list', '--repo', repo, '--state', 'merged',
      '--limit', String(WINDOW), '--json', 'author,mergedBy,createdAt,mergedAt'])), now)
    const says = took.length === 0
      ? `none in ${String(DAYS)} days`
      : `${String(took.length)} in ${String(DAYS)} days, median ${String(p50(took))}d to merge`
    return { check: 'outside merges', ok: took.length > 0, says }
  }
}

/** Whole days to merge of each outsider pull request merged in the window. */
function outside(merged: z.infer<typeof Merged>, now: Date): number[] {
  const mergers = logins(merged.map((p) => p.mergedBy))
  return merged.flatMap((p) => {
    if (p.author === null || mergers.includes(p.author.login) || p.mergedAt === null) return []
    const at = Date.parse(p.mergedAt)
    return now.getTime() - at > DAYS * DAY ? [] : [Math.floor((at - Date.parse(p.createdAt)) / DAY)]
  })
}
