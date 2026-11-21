import { cycle } from '../sequencer/cycle.ts'
import { CREDITS, monthly } from '../sequencer/ready.ts'

export function greptileLine(root: string, now: Date): string {
  const asked = monthly(root, now)
  return `greptile ${String(asked)}/${String(CREDITS)} asked this cycle, ${String(CREDITS - asked)} left, resets ${cycle(now).reset.toISOString().slice(0, 10)}\n`
}
