import { setTimeout as sleep } from 'node:timers/promises'
import type { Db } from '../store/index.ts'
import { holder } from '../store/leases.ts'

const POLL = 5_000

export function unleased(db: Db, plan: number, wait: string | undefined, refusal: string, then: () => void): void | Promise<void> {
  if (wait !== undefined) return waited(db, plan, Date.now() + Number(wait) * 60_000, `${refusal} after waiting ${wait} min`, then)
  if (holder(db, plan) !== null) throw new Error(refusal)
  then()
}

async function waited(db: Db, plan: number, end: number, refusal: string, then: () => void): Promise<void> {
  while (holder(db, plan) !== null) {
    const left = end - Date.now()
    if (left <= 0) throw new Error(refusal)
    await sleep(Math.min(POLL, left))
  }
  then()
}
