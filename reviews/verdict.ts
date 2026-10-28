import { createHash } from 'node:crypto'
import { parse, parseDocument } from 'yaml'
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

const KINDS = ['text', 'count', 'restore', 'language'] as const

/** A cosmetic edit a pass carries for landing to apply, or a `language` point landing only logs: `old` becomes `new` at `file:line`. */
export interface Note {
  file: string
  line: number
  old: string
  new: string
  why: string
  kind: typeof KINDS[number]
}

const Noted = z.object({ file: z.string(), line: z.number().int().positive(), old: z.string(), new: z.string(), why: z.string(), kind: z.string() })

type Written = z.infer<typeof Noted>

const Block = z.object({
  id: z.string().regex(/^F\d+$/),
  file: z.string().min(1),
  line: z.number().int().positive(),
  rule: z.string().min(1),
  required_change: z.string().min(1),
  verify: z.string().min(1),
})

const Fence = z.object({
  outcome: z.enum(['pass', 'refuse', 'needs_ceo']),
  class: z.union([z.literal('claim.unverified'), z.string().regex(/^[a-z_]+$/)]).nullish(),
  spans: z.array(Span).nullish(),
  findings: z.array(Block).nullish(),
  reopen: z.record(z.string(), z.string()).nullish(),
  notes: z.array(Noted).nullish(),
}).refine((f) => f.outcome !== 'refuse' || ((f.spans ?? []).length + (f.findings ?? []).length > 0 && f.class != null))

const Asked = z.object({ outcome: z.string(), findings: z.array(z.unknown()).nullish() })
const Id = z.object({ id: Block.shape.id })

export const FENCE = /^(?:```\w*\r?\n)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n```)?\s*$/m
const LOOSE = /(?<=^[ \t]*(?:- )?\w+: )(["']).*?\1[ \t]+[^\s#].*$/gm

/** A verdict as the reviewer wrote it: the row, its findings, and the new fact it names for each span it re-opens. */
export interface Judged extends Verdict {
  findings: Finding[]
  reopen: Record<string, string>
  notes: Note[]
}

export function read(reply: string, subject: string): Judged | null {
  const found = FENCE.exec(reply)
  if (found === null) return null
  const fence = Fence.safeParse(yaml(found[1] ?? ''))
  if (!fence.success) return null
  const subject_digest = createHash('sha256').update(subject).digest('hex')
  const prose = reply.slice(0, found.index).trim()
  if (fence.data.outcome === 'pass') return passed(fence.data.notes ?? [], prose, subject_digest)
  if (fence.data.outcome !== 'refuse') {
    return { outcome: fence.data.outcome, defect_class: null, spans: [], findings: [], subject_digest, origin_kind: null, origin_ref: null, message: prose, reopen: {}, notes: [] }
  }
  const blocks = fence.data.findings ?? []
  const findings = [...fence.data.spans ?? [], ...blocks.map((b) => ({ span: `${b.file}:${String(b.line)}`, kind: 'real' as const, fix: null }))]
  return {
    outcome: 'refuse',
    defect_class: fence.data.class ?? null,
    spans: findings.map((f) => f.span),
    findings,
    subject_digest,
    origin_kind: 'ruling',
    origin_ref: 'reviewers.verdict',
    message: [prose, blocks.map((b) => `- ${b.id} ${b.file}:${String(b.line)} ${b.rule}: ${b.required_change}; verify: ${b.verify}`).join('\n')].filter((s) => s !== '').join('\n\n'),
    reopen: fence.data.reopen ?? {},
    notes: [],
  }
}

/** The first finding block a refuse leaves out or leaves a field empty in, or null when none does. */
export function unfilled(reply: string): string | null {
  const found = FENCE.exec(reply)
  const fence = Asked.safeParse(found === null ? null : yaml(found[1] ?? ''))
  if (!fence.success || fence.data.outcome !== 'refuse') return null
  const blocks = fence.data.findings ?? []
  if (blocks.length === 0) return 'refuse has no findings'
  for (const [i, block] of blocks.entries()) {
    const whole = Block.safeParse(block)
    if (whole.success) continue
    const id = Id.safeParse(block)
    return `${id.success ? id.data.id : `finding ${String(i + 1)}`} has no ${String(whole.error.issues[0]?.path[0] ?? 'fields')}`
  }
  return null
}

function known(n: Written): n is Note {
  return (KINDS as readonly string[]).includes(n.kind)
}

function passed(notes: Written[], prose: string, subject_digest: string): Judged {
  const stray = notes.filter((n) => !known(n))
  if (stray.length === 0) {
    return { outcome: 'pass', defect_class: null, spans: [], findings: [], subject_digest, origin_kind: null, origin_ref: null, message: prose === '' ? 'pass' : prose, reopen: {}, notes: notes.filter(known) }
  }
  const spans = stray.map((n) => `${n.file}:${String(n.line)}`)
  return {
    outcome: 'refuse',
    defect_class: 'scope',
    spans,
    findings: spans.map((span) => ({ span, kind: 'real' as const, fix: null })),
    subject_digest,
    origin_kind: 'ruling',
    origin_ref: 'reviewers.verdict',
    message: [prose, ...stray.map((n) => `note of no known kind ${n.kind} at ${n.file}:${String(n.line)}`)].join('\n').trim(),
    reopen: {},
    notes: [],
  }
}

function yaml(body: string): unknown {
  try {
    const doc = parseDocument(body)
    return doc.errors.length === 0 ? doc.toJS() : parse(body.replace(LOOSE, (value) => JSON.stringify(value)))
  } catch {
    return null
  }
}
