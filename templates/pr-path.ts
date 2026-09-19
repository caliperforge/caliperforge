export type Fires = 'kernel' | 'brief' | 'seat' | 'review' | 'ceo'

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

/** The builder a target whose language names no seat of its own falls to. */
export const DEFAULT_BUILDER = 'typescript_specialist'

/** The seat that turns the ask into the brief, in any language: it reads the code and writes nothing. */
export const BRIEF_WRITER = 'brief_writer'

const BUILDERS: Record<string, string> = { kotlin: 'kotlin_specialist', typescript: DEFAULT_BUILDER }

/** Which seat builds: the target's language picks it. */
export function builder(language: string | null): string {
  return (language === null ? undefined : BUILDERS[language]) ?? DEFAULT_BUILDER
}

export const steps: Step[] = [
  { step: 0, name: 'measure', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'target', gate: false, writes_verdict: false, verdict_gate: null },
  { step: 1, name: 'ruling', seat: BRIEF_WRITER, fires: 'brief', runs: BRIEF_WRITER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 2, name: 'build', seat: DEFAULT_BUILDER, fires: 'seat', runs: DEFAULT_BUILDER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 3, name: 'rails', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'pre_review', gate: true, writes_verdict: true, verdict_gate: 'pre_review' },
  { step: 4, name: 'review', seat: DEFAULT_BUILDER, fires: 'review', runs: 'code_quality', gate: true, writes_verdict: true, verdict_gate: 'review' },
  { step: 5, name: 'senior', seat: DEFAULT_BUILDER, fires: 'review', runs: 'senior_review', gate: true, writes_verdict: true, verdict_gate: 'senior_review' },
  { step: 6, name: 'ready', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'ready', gate: true, writes_verdict: true, verdict_gate: 'ready' },
  { step: 7, name: 'batch', seat: DEFAULT_BUILDER, fires: 'ceo', runs: 'approval', gate: false, writes_verdict: false, verdict_gate: null },
  { step: 8, name: 'push', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'push', gate: false, writes_verdict: false, verdict_gate: null },
]

export function last(step: number): boolean {
  return step === (steps.at(-1)?.step ?? 0)
}

export function at(step: number, language: string | null = null): Step {
  const found = steps.find((s) => s.step === step)
  if (found === undefined) throw new Error(`pr-path has no step ${String(step)}`)
  if (found.fires === 'brief') return found
  const seat = builder(language)
  return found.fires === 'seat' ? { ...found, seat, runs: seat } : { ...found, seat }
}
