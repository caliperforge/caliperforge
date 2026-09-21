import { createHash } from 'node:crypto'
import type { Verdict } from '../record.ts'

export interface Proof {
  repo: string
  /** Our own repository: nobody measures us, so there is no account pulse to read (#20). */
  ours: boolean
  at: string
  tests_pass: boolean
  byte_identical_elsewhere: boolean
  fork_public: boolean
  bot_clean: boolean
  ci: Verdict
  spans: string[]
}

export function ready(proof: Proof): Verdict {
  const spans = [
    ...(proof.tests_pass ? [] : ['tests:1 ready.tests']),
    ...(proof.byte_identical_elsewhere ? [] : ['tree:1 ready.byte_identical']),
    ...(proof.ci.outcome === 'pass' ? [] : proof.ci.spans),
    ...(proof.fork_public ? [] : ['fork:1 not.public']),
    ...(proof.bot_clean ? [] : ['bot:1 ready.bot_clean']),
    ...(proof.spans.length === 0 ? ['spans:1 no.anchor'] : []),
  ]
  const subject_digest = digest(proof)
  if (spans.length === 0) {
    return { outcome: 'pass', defect_class: null, origin_kind: null, origin_ref: null, subject_digest, spans, message: `${proof.repo} is green, confined to ${String(proof.spans.length)} named span(s)` }
  }
  return {
    outcome: 'refuse', defect_class: null,
    origin_kind: 'rail',
    origin_ref: 'ready',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) keep the deliverable out of the batch`,
  }
}

function digest(proof: Proof): string {
  return createHash('sha256')
    .update([proof.repo, proof.at, proof.spans.join(','), proof.ci.subject_digest].join('\n'))
    .digest('hex')
}
