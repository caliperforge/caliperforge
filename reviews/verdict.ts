import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Verdict } from '../store/verdict.ts'

export type { Verdict }

/** A span the reviewer named. `cosmetic` carries the replacement text that settles it; anything else is a rebuild. */
export interface Finding {
  span: string
  kind: 'real' | 'cosmetic'
  fix: string | null
}

const Named = z.object({
  span: z.string(),
  kind: z.enum(['real', 'cosmetic']).default('real'),
  fix: z.string().nullish().default(null),
})

const Span = z.union([z.string().transform((span) => ({ span, kind: 'real' as const, fix: null })), Named])

const Fence = z.object({
  outcome: z.enum(['pass', 'refuse', 'needs_ceo']),
  class: z.string().regex(/^[a-z_]+$/).nullish(),
  spans: z.array(Span).nullish(),
  reopen: z.record(z.string(), z.string()).nullish(),
}).refine((f) => f.outcome !== 'refuse' || ((f.spans ?? []).length > 0 && f.class != null))

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\s*$/m

/** A verdict as the reviewer wrote it: the row, its findings, and the new fact it names for each span it re-opens. */
export interface Judged extends Verdict {
  findings: Finding[]
  reopen: Record<string, string>
}

export function read(reply: string, subject: string): Judged | null {
  const found = FENCE.exec(reply)
  if (found === null) return null
  const fence = Fence.safeParse(yaml(found[1] ?? ''))
  if (!fence.success) return null
  const subject_digest = createHash('sha256').update(subject).digest('hex')
  if (fence.data.outcome !== 'refuse') {
    return { outcome: fence.data.outcome, defect_class: null, spans: [], findings: [], subject_digest, origin_kind: null, origin_ref: null, message: fence.data.outcome, reopen: {} }
  }
  const findings = fence.data.spans ?? []
  return {
    outcome: 'refuse',
    defect_class: fence.data.class ?? null,
    spans: findings.map((f) => f.span),
    findings,
    subject_digest,
    origin_kind: 'ruling',
    origin_ref: 'reviewers.verdict',
    message: reply.slice(0, found.index).trim(),
    reopen: fence.data.reopen ?? {},
  }
}

function yaml(body: string): unknown {
  try {
    return parse(body)
  } catch {
    return null
  }
}
