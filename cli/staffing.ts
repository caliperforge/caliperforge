import { staffing } from '../sequencer/staffing.ts'
import { steps as comms } from '../templates/comms.ts'
import { steps as prPath } from '../templates/pr-path.ts'

interface Cell { template: string; step: number; key: string | null }

export function unstaffed(root: string): Cell[] {
  const rows = staffing(root)
  return Object.entries({ pr_path: prPath, comms }).flatMap(([template, steps]) => {
    const keys = [...new Set(rows.flatMap((r) => r.template === template && r.key !== undefined ? [r.key] : [])), null]
    return steps.flatMap(({ step }) => keys.flatMap((key) =>
      rows.some((r) => r.template === template && r.step === step && (r.key ?? null) === key) ? [] : [{ template, step, key }]))
  })
}

export function staffingSection(cells: Cell[]): string {
  const body = cells.length === 0 ? '  none\n' : cells.map((c) => `  ${c.template}\tstep ${String(c.step)}\t${c.key ?? '-'}\n`).join('')
  return `unstaffed cells (${String(cells.length)})\n${body}`
}
