import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Db } from '../../store/index.ts'
import type { Verdict } from '../../store/verdict.ts'
import { parse as hunks } from '../diff.ts'

export type { Verdict }

const Manifest = z.object({
  rail: z.literal('completion-audit'),
  gate: z.literal('pre_review'),
  step: z.int().min(0).max(9),
  defect_class: z.string(),
})

const Envelope = z.object({
  done: z.array(z.object({
    id: z.string(),
    status: z.enum(['done', 'cannot-be-done', 'they-said-dont']),
    pointer: z.string().nullish(),
  })).min(1),
})

export function audit(handback: string, expected: string[], prev = '', diff = ''): Verdict {
  const rows = carried(handback)
  const subject = createHash('sha256').update(handback).digest('hex')
  const absent = expected.filter((id) => (rows.get(id)?.pointer ?? '').trim() === '')
  const stands = untouched(prev, diff)
  const forward = absent.filter(stands)
  const spans = absent.filter((id) => !stands(id))
  if (spans.length === 0) return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest: subject, spans, message: `${String(expected.length)} done-condition(s) carried with a pointer${also(forward)}` }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'completion-audit',
    subject_digest: subject,
    spans,
    message: `${spans.join(', ')} expected by the ticket, absent from the handback or carried with no pointer`,
  }
}

export function record(db: Db, plan: number, verdict: Verdict, seconds: number): number {
  const manifest = Manifest.parse(parse(readFileSync(join(import.meta.dirname, 'manifest.yaml'), 'utf8')))
  const row = db.prepare(`INSERT INTO verdicts
    (gate, kind, subject_digest, plan, step, outcome, rail_id, origin_kind, origin_ref, tokens, seconds)
    VALUES (?, 'rail', ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(manifest.gate, verdict.subject_digest, plan, manifest.step, verdict.outcome,
      manifest.rail, verdict.origin_kind, verdict.origin_ref, seconds)
  return Number(row.lastInsertRowid)
}

/**
 * A rebuild reports on what it rebuilt, so a row the previous hand-back called done at a pointer the
 * rebuild's diff never touched still stands, and the fence leaving it out is not a case gone unanswered.
 */
function untouched(prev: string, diff: string): (id: string) => boolean {
  const touched = new Set(hunks(diff).map((file) => file.path))
  const rows = carried(prev)
  return (id) => {
    const row = rows.get(id)
    const path = (row?.pointer ?? '').split(':')[0] ?? ''
    return row?.status === 'done' && path !== '' && !touched.has(path)
  }
}

function also(forward: string[]): string {
  return forward.length === 0 ? '' : `, ${forward.join(', ')} carried forward from the previous handback`
}

function carried(handback: string): Map<string, z.infer<typeof Envelope>['done'][number]> {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\s*$/m.exec(handback)
  if (fence === null) return new Map()
  const body = fence[1] ?? ''
  const envelope = Envelope.safeParse(yaml(body))
  const rows = envelope.success ? envelope : Envelope.safeParse(yaml(doneOnly(body)))
  if (!rows.success) return new Map()
  return new Map(rows.data.done.map((row) => [row.id, row]))
}

/** 09-26: a `summary:` line holding an unquoted `: ` broke the whole fence, so the rows the audit needs are read on their own. */
function doneOnly(body: string): string {
  const at = /^done:/m.exec(body)
  if (at === null) return ''
  const rest = body.slice(at.index).split('\n')
  const end = rest.findIndex((line, i) => i > 0 && /^\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

function yaml(text: string): unknown {
  try {
    return parse(text)
  } catch {
    return null
  }
}
