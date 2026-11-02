import { z } from 'zod'
import { fenceOf, split, yamlOf, type Refused } from './brief.ts'

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

const Ordered = z.object({ outcome: z.literal('split'), parts: z.array(z.object({ after: z.unknown().optional() })).catch([]) })

export function named(after: unknown, i: number): boolean {
  return after === undefined || (typeof after === 'string' && (after.toLowerCase() === 'none' ||
    (after.length === 1 && LETTERS.slice(0, i).includes(after.toLowerCase()))))
}

/** The first part of a split fence whose `after:` the split cannot read, else a split fence the split cannot read at all. */
export function ordered(reply: string): Refused | null {
  const fence = fenceOf(reply)
  const parsed = Ordered.safeParse(fence === null ? null : yamlOf(fence))
  if (!parsed.success) return null
  const i = parsed.data.parts.findIndex((p, n) => !named(p.after, n))
  if (i === -1) return split(reply) === null ? { span: 'split fence', reason: 'the split fence is no split: at least two parts, each with title, what, why and ends' } : null
  return { span: 'after:', reason: `part ${LETTERS.charAt(i)}'s after: ${String(parsed.data.parts[i]?.after)} is not none or the letter of one part before it` }
}
