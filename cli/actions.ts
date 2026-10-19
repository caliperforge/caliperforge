import { z } from 'zod'
import { gh, type Read } from './gh.ts'

/** GitHub registers a new fork's workflows only once someone enables them in its Actions tab, and no API turns them on. */
export function actions(fork: string, read: Read = gh): boolean {
  return z.object({ total_count: z.int() }).parse(read(['api', `repos/${fork}/actions/workflows`])).total_count > 0
}
