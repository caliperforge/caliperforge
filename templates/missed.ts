import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { maybe } from '../sequencer/workspace.ts'
import { logged } from '../store/events.ts'
import { fields } from './bench.ts'
import { fixed, graded, type Phase, type Touched } from './graded.ts'
import type { Bench, Sum } from './phases.ts'
import { kept } from './powered.ts'

type Graded = 'context' | 'scaffold' | 'coverage'

const GRADES: Record<Graded, [Phase, string[]]> = {
  context: ['context', []],
  scaffold: ['suite', ['test/fizz/handlers', 'test/fizz/Properties.sol']],
  coverage: ['coverage', ['test/fizz/fizz_data/handoff/coverage.md', 'test/fizz/fizz_data/corpus_medusa/coverage/lcov.info']],
}

const gradable = (phase: string): phase is Graded => Object.hasOwn(GRADES, phase)

function missed({ db, root: home, plan, name }: Bench, phase: Graded, root: string, fix: () => Touched | string, { tokens, seconds }: Sum): Outcome | null {
  const [kind, needs] = GRADES[phase]
  const t = fix()
  const missing = typeof t === 'string' ? undefined : needs.find((path) => !existsSync(join(root, path)))
  const line = typeof t === 'string' ? t : missing !== undefined ? `cannot run: needs ${missing}` : graded(kind, root, t)
  if (!line.startsWith('miss')) {
    logged(db, { plan: plan.id, kind: 'bench.grade', actor: name, outcome: 'pass', message: `${phase}: ${line}`, pointer: null, run: null })
    return null
  }
  const { target = '', generator = '' } = fields(maybe(home, plan.id, 'target.yml') ?? '')
  kept(db, home, plan.id, { target, generator }, { catches: 0, false_positives: 0, untested: null, tokens, seconds, x_ray: null, pre_fix_calls: null, fix_calls: null, not_powered: `${phase}_missed` })
  return { outcome: 'needs_coo', spans: ['bench.grade'], note: line }
}

export function grader(bench: Bench, root: string): (phase: string, sum: Sum) => Outcome | null {
  let t: Touched | string | undefined
  const fix = (): Touched | string => t ??= fixed(bench.root, bench.plan.id, root)
  return (phase, sum) => gradable(phase) ? missed(bench, phase, root, fix, sum) : null
}
