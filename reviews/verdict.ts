import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Verdict } from '../store/verdict.ts'

export type { Verdict }

const Fence = z.object({
  outcome: z.enum(['pass', 'refuse', 'needs_ceo']),
  class: z.enum(['correctness', 'scope', 'approach', 'minimal']).nullish(),
  spans: z.array(z.string()).nullish(),
}).refine((f) => f.outcome !== 'refuse' || ((f.spans ?? []).length > 0 && f.class != null))

export function read(reply: string, subject: string): Verdict | null {
  const fence = Fence.safeParse(yaml(reply))
  if (!fence.success) return null
  const subject_digest = createHash('sha256').update(subject).digest('hex')
  if (fence.data.outcome !== 'refuse') {
    return { outcome: fence.data.outcome, defect_class: null, spans: [], subject_digest, origin_kind: null, origin_ref: null, message: fence.data.outcome }
  }
  return {
    outcome: 'refuse',
    defect_class: fence.data.class ?? null,
    spans: fence.data.spans ?? [],
    subject_digest,
    origin_kind: 'ruling',
    origin_ref: 'reviewers.verdict',
    message: `${String(fence.data.class)}: ${(fence.data.spans ?? []).join(', ')}`,
  }
}

function yaml(reply: string): unknown {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\s*$/m.exec(reply)
  if (fence === null) return null
  try {
    return parse(fence[1] ?? '')
  } catch {
    return null
  }
}
