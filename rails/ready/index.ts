import { createHash } from 'node:crypto'
import type { Db } from '../../store/index.ts'
import type { Verdict } from '../record.ts'

const WARM_DAYS = 30

export interface Proof {
  repo: string
  at: string
  tests_pass: boolean
  byte_identical_elsewhere: boolean
  fork_public: boolean
  bot_clean: boolean
  ci: Verdict
  spans: string[]
}

export function ready(db: Db, proof: Proof): Verdict {
  const spans = [
    ...(proof.tests_pass ? [] : ['tests:1 ready.tests']),
    ...(proof.byte_identical_elsewhere ? [] : ['tree:1 ready.byte_identical']),
    ...(proof.ci.outcome === 'pass' ? [] : proof.ci.spans),
    ...(proof.fork_public ? [] : ['fork:1 not.public']),
    ...(proof.bot_clean ? [] : ['bot:1 ready.bot_clean']),
    ...(warm(db, proof) ? [] : [`${proof.repo}:1 stale.verdict`]),
    ...(proof.spans.length === 0 ? ['spans:1 no.anchor'] : []),
  ]
  const subject_digest = digest(proof)
  if (spans.length === 0) {
    return { outcome: 'pass', origin_kind: null, origin_ref: null, subject_digest, spans, message: `${proof.repo} is warm and green, confined to ${String(proof.spans.length)} named span(s)` }
  }
  return {
    outcome: 'refuse',
    origin_kind: 'rail',
    origin_ref: 'ready',
    subject_digest,
    spans,
    message: `${String(spans.length)} span(s) keep the deliverable out of the batch`,
  }
}

function warm(db: Db, proof: Proof): boolean {
  const row = db
    .prepare('SELECT pulse, julianday(?) - julianday(measured_at) AS age FROM accounts WHERE repo = ? ORDER BY measured_at DESC LIMIT 1')
    .get(proof.at, proof.repo) as { pulse: string; age: number } | undefined
  return row?.pulse === 'warm' && row.age <= WARM_DAYS
}

function digest(proof: Proof): string {
  return createHash('sha256')
    .update([proof.repo, proof.at, proof.spans.join(','), proof.ci.subject_digest].join('\n'))
    .digest('hex')
}
