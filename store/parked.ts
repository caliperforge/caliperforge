import type { Wait } from './plans.ts'

/** The waits a person or the outside world ends: a running plan on one takes no slot. */
export const PARKED = ['ceo_batch', 'target_approval', 'ready_proof', 'target_parked'] as const satisfies readonly Wait[]

/** SQL for a row that holds a slot; `as` is the table alias with its dot. */
export function slot(as = ''): string {
  return `${as}state = 'running' AND coalesce(${as}wait_reason, '') NOT IN (${PARKED.map((w) => `'${w}'`).join(', ')})`
}
