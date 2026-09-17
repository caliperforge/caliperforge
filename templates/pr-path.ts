export type Fires = 'kernel' | 'seat' | 'review' | 'ceo'

export type Gate = 'premise' | 'target' | 'pre_review' | 'review' | 'senior_review' | 'ready'

export interface Step {
  step: number
  name: string
  seat: string
  fires: Fires
  runs: string
  gate: boolean
  writes_verdict: boolean
  verdict_gate: Gate | null
}

const OWNER = 'typescript_specialist'

export const steps: Step[] = [
  { step: 0, name: 'measure', seat: OWNER, fires: 'kernel', runs: 'target', gate: false, writes_verdict: false, verdict_gate: null },
  { step: 1, name: 'ruling', seat: OWNER, fires: 'kernel', runs: 'approval', gate: false, writes_verdict: false, verdict_gate: null },
  { step: 2, name: 'build', seat: OWNER, fires: 'seat', runs: OWNER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 3, name: 'rails', seat: OWNER, fires: 'kernel', runs: 'pre_review', gate: true, writes_verdict: true, verdict_gate: 'pre_review' },
  { step: 4, name: 'review', seat: OWNER, fires: 'review', runs: 'code_quality', gate: true, writes_verdict: true, verdict_gate: 'review' },
  { step: 5, name: 'senior', seat: OWNER, fires: 'review', runs: 'senior_review', gate: true, writes_verdict: true, verdict_gate: 'senior_review' },
  { step: 6, name: 'ready', seat: OWNER, fires: 'kernel', runs: 'ready', gate: true, writes_verdict: true, verdict_gate: 'ready' },
  { step: 7, name: 'batch', seat: OWNER, fires: 'ceo', runs: 'approval', gate: false, writes_verdict: false, verdict_gate: null },
]

export function at(step: number): Step {
  const found = steps.find((s) => s.step === step)
  if (found === undefined) throw new Error(`pr-path has no step ${String(step)}`)
  return found
}
