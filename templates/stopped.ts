import { existsSync, renameSync, rmSync } from 'node:fs'
import type { Outcome } from '../sequencer/kind.ts'
import { ofKind } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { HOLDERS, needsCeo, type PlanRow } from '../store/plans.ts'

const LOOK = 'still stopped for a look: cf unpark --by ceo or coo resumes it'

export function unstopped(db: Db, plan: PlanRow, src: string): Outcome | null {
  const aside = `${src}.stopped`
  if (!existsSync(aside)) return null
  const events = ofKind(db, 'stop_after', 'return', 'retry').filter((e) => e.plan === plan.id)
  if (!events.slice(events.findLastIndex((e) => e.kind === 'stop_after') + 1).some((e) => HOLDERS.some((h) => h === e.actor))) {
    needsCeo(db, plan, LOOK)
    return { outcome: 'pass', held: true, spans: ['bench.stop_after'], note: LOOK }
  }
  rmSync(src, { recursive: true, force: true })
  renameSync(aside, src)
  return null
}
