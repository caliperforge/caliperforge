import type { Seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { maybe } from '../sequencer/workspace.ts'
import { logged } from '../store/events.ts'
import { fields } from './bench.ts'
import { type Check, FIX, fixed, type Fixed } from './fixturn.ts'
import type { Refused } from './handoff.ts'
import { type Bench, firing, type Sum } from './phases.ts'
import { KINDS } from './report.ts'

export const REPORT_ONLY = ['suite.outside', 'reach.unmet', 'reach.boundary']

export function fixing(bench: Bench, manifest: Seat, hash: string, handoffs: string, phase: string, sum: Sum) {
  const { db, root, plan, name, dir } = bench
  const at = { fire: firing(bench, { ...manifest, ...FIX }, hash), dir, handoffs }
  const only = (fields(maybe(root, plan.id, 'target.yml') ?? '').report_only_checks ?? '').split(',')
  const fixes = {
    sum,
    only,
    log: (kind: string, outcome: 'pass' | 'refuse', message: string): void => { logged(db, { plan: plan.id, kind, actor: name, outcome, message, pointer: null, run: null }) },
    fix: async (check: Check): Promise<Fixed | Sum | Outcome> => {
      let kept: Refused[] = []
      const run = (): Refused[] => {
        const rows = check.run()
        kept = rows.filter((r) => only.includes(r.rule))
        return rows.filter((r) => !only.includes(r.rule))
      }
      const got = await fixed(at, { ...check, run }, phase, fixes.sum)
      if ('outcome' in got || got.sum.wall !== null) return 'outcome' in got ? got : got.sum
      for (const row of got.turns) fixes.log(KINDS.fix_turns, 'pass', JSON.stringify(row))
      if (got.not_clean !== null) fixes.log(KINDS.critic, 'refuse', got.not_clean)
      for (const row of kept) fixes.log(KINDS.report_only, 'pass', JSON.stringify(row))
      fixes.sum = got.sum
      return got
    },
  }
  return fixes
}
