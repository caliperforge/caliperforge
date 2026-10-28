import { createHash } from 'node:crypto'
import { section } from '../../sequencer/brief.ts'
import type { Verdict } from '../../store/verdict.ts'

/** Each open review finding needs a `fixed:` or `disputed:` row under `## Findings answered`, above the fence. */
export function answers(handback: string, open: string[]): Verdict {
  const rows = section(handback, '## Findings answered').split(/^---$/m)[0] ?? ''
  const answered = new Set([...rows.matchAll(/^- (F\d+) (?:fixed|disputed): \S/gm)].map((m) => m[1]))
  const missing = open.filter((id) => !answered.has(id))
  const subject_digest = createHash('sha256').update(handback).digest('hex')
  if (missing.length === 0) {
    return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans: [], message: `${String(open.length)} finding(s) answered` }
  }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'completion-audit',
    subject_digest,
    spans: missing,
    message: `${missing.join(', ')} open from the last review refuse, with no fixed: or disputed: row under ## Findings answered`,
  }
}
