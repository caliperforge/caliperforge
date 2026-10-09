import { join } from 'node:path'
import { staffed, staffing } from '../sequencer/staffing.ts'
import type { Run } from '../store/events.ts'

type Fires ='kernel' | 'brief' | 'seat' | 'review' | 'ceo'

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
  mode?: Run['mode']
  design?: true
  outside?: string
}

export const ROOT = join(import.meta.dirname, '..')

/** The builder a target whose language names no seat of its own falls to. */
export const DEFAULT_BUILDER = 'typescript_specialist'

const BRIEF_WRITER = 'brief_writer'

function staff(step: number, language: string | null): { seat: string; mode?: Run['mode'] } {
  const row = staffed(ROOT, 'pr_path', step, language) ?? staffed(ROOT, 'pr_path', step, null)
  if (row === null) throw new Error(`pr-path step ${String(step)} has no seat in rules/staffing.yaml`)
  return row
}

/** Which seat builds: the target's language picks it. */
export function builder(language: string | null): string | null {
  return staffed(ROOT, 'pr_path', 2, language)?.seat ?? null
}

/** The language whose builder is `seat`, or null when none is. */
export function languageOfSeat(seat: string | null): string | null {
  return staffing(ROOT).find((r) => r.template === 'pr_path' && r.step === 2 && r.key !== undefined && r.seat === seat)?.key ?? null
}

export const steps: Step[] = [
  { step: 0, name: 'measure', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'target', gate: false, writes_verdict: false, verdict_gate: null },
  { step: 1, name: 'ruling', seat: BRIEF_WRITER, fires: 'brief', runs: BRIEF_WRITER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 2, name: 'build', seat: DEFAULT_BUILDER, fires: 'seat', runs: DEFAULT_BUILDER, gate: false, writes_verdict: false, verdict_gate: null },
  { step: 3, name: 'rails', seat: DEFAULT_BUILDER, fires: 'kernel', runs: 'pre_review', gate: true, writes_verdict: true, verdict_gate: 'pre_review' },
  { step: 4, name: 'review', seat: DEFAULT_BUILDER, fires: 'review', runs: 'code_quality', gate: true, writes_verdict: true, verdict_gate: 'review' },
  { step: 5, name: 'senior', seat: DEFAULT_BUILDER, fires: 'review', runs: 'senior_review', gate: true, writes_verdict: true, verdict_gate: 'senior_review', outside: 'blind_review' },
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
  const { seat, mode } = staff(step, language)
  const seated: Step = { ...found, seat, ...(mode === undefined ? {} : { mode }) }
  if (found.verdict_gate === 'review' && language === 'web') return { ...seated, design: true }
  return found.fires === 'seat' ? { ...seated, runs: seat } : seated
}
