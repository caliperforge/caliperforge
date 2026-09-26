import { fingerprint, WHY, type Why } from '../store/refusals.ts'
import type { Step } from '../templates/pr-path.ts'
import type { Outcome } from './kind.ts'
import { maybe, put } from './workspace.ts'

/**
 * A failed check or CI run is known by what failed, not by the one span every such failure shares. So is a
 * `text:N` span, a line of this job's own brief or handback: plans 24 and 130 both drew "text:5
 * identifier.unresolved" for different names, read as one fault on main, and the internal lane went off on 09-25.
 */
export function fingerprintOf(step: Step, outcome: Outcome): string {
  const checked = outcome.spans.some((s) => s.startsWith('checks:') || s.startsWith('ci.red'))
  const own = outcome.spans.some((s) => s.startsWith('text:'))
  return fingerprint(step.step, own ? [...outcome.spans, outcome.note] : outcome.spans, checked ? (outcome.message ?? '') : '')
}

export function stopped(root: string, plan: number, why: Exclude<Why, 'again'>): void {
  put(root, plan, 'refusal.md', `${maybe(root, plan, 'refusal.md') ?? ''}
# Stopped

${WHY[why]}.
`)
}

export function refusalText(step: Step, outcome: Outcome): string {
  const spans = outcome.spans.length === 0 ? '  (none named)' : outcome.spans.map((s) => `  - ${s}`).join('\n')
  const words = outcome.message === undefined ? '' : `\n${outcome.message}\n`
  return `step ${String(step.step)} ${step.name} refused by ${step.runs}\n\n${outcome.note}\n\nspans:\n${spans}\n${words}`
}
