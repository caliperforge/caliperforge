import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { maybe } from './workspace.ts'

export const CREDITS = 50

export const FIRST_ONLY = 40

export const ASKED = 'greptile.asked'

export function monthly(root: string, now: Date): number {
  const month = now.toISOString().slice(0, 7)
  const work = join(root, '.cf/work')
  if (!existsSync(work)) return 0
  return readdirSync(work)
    .flatMap((plan) => (maybe(root, Number(plan), ASKED) ?? '').split('\n'))
    .filter((l) => l.split(' ')[1]?.startsWith(month) === true).length
}
