import { DEFAULT_BUILDER, type Step } from './pr-path.ts'

export const steps: Step[] = ['checkout', 'generate', 'score'].map((name, step) =>
  ({ step, name, seat: DEFAULT_BUILDER, fires: 'kernel', runs: name, gate: false, writes_verdict: false, verdict_gate: null }))
