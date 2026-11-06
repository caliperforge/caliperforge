import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planDir } from '../sequencer/workspace.ts'
import { phasesOf, STOPPED, stoppedAt } from './phases.ts'

function resuming(root: string, plan: number): { phases: string[]; handoffs: string; next: number; phase: string } | null {
  const handoffs = join(planDir(root, plan), 'src/test/fizz/fizz_data/handoff')
  if (!existsSync(handoffs)) return null
  const phases = phasesOf(join(root, 'seats/fizz_lean_generator/skill'))
  const stopped = stoppedAt(handoffs)
  const next = stopped === null ? 0 : phases.indexOf(stopped.phase) + 1
  return { phases, handoffs, next, phase: phases[next] ?? 'end' }
}

export const resumesAt = (root: string, plan: number): string | null => resuming(root, plan)?.phase ?? null

export function restartAt(root: string, plan: number, phase: string): void {
  const at = resuming(root, plan)
  if (at === null) throw new Error(`plan ${String(plan)} has no lean handoff to restart`)
  const to = at.phases.indexOf(phase)
  if (to === -1) throw new Error(`no lean phase ${phase}: ${at.phases.join(', ')}`)
  if (to > at.next) throw new Error(`plan ${String(plan)} resumes at ${at.phase}, before ${phase}`)
  const path = join(at.handoffs, STOPPED)
  if (to === 0) rmSync(path, { force: true })
  else writeFileSync(path, JSON.stringify({ ...stoppedAt(at.handoffs), phase: at.phases[to - 1] }))
}
