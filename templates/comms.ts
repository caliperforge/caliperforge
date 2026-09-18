import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

/** A merge signal opens one of these. P7 fills the write-up and its voice fixtures. */
export const steps: Step[] = [
  { step: 0, name: 'draft', seat: DEFAULT_BUILDER, fires: 'seat', runs: DEFAULT_BUILDER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 1, name: 'review', seat: DEFAULT_BUILDER, fires: 'review', runs: 'code_quality', gate: true, writes_verdict: true, verdict_gate: 'review' },
  { step: 2, name: 'batch', seat: DEFAULT_BUILDER, fires: 'ceo', runs: 'approval', gate: false, writes_verdict: false, verdict_gate: null },
]
