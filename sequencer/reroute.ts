import type { Db } from '../store/index.ts'
import { LANE } from '../store/lanes.ts'
import { lanePipe } from '../store/origins.ts'
import { builderRan, pipeNamed, type PlanRow } from '../store/plans.ts'
import { toResearch } from '../store/reroute.ts'
import { unasked, work } from '../templates/research.ts'
import { unhold } from './hold.ts'
import { kernelPlan } from './home.ts'
import { rule } from './rule.ts'
import { maybe, move } from './workspace.ts'

const OUTPUT = '**Output:**'

function asked(text: string): boolean {
  const lines = text.split('\n')
  const out = lines.find((l) => l.startsWith(OUTPUT))?.slice(OUTPUT.length).trim()
  return unasked(text).length === 0 && lines.some((l) => l.startsWith('**Measure:**')) && out !== undefined && work(out) !== null
}

/** An unbuilt pr_path plan of ours goes to the research lane at step 0, its ask carrying the research lines. */
export function rerouted(db: Db, root: string, plan: PlanRow, answer: string): boolean {
  if (plan.template !== 'pr_path' || !kernelPlan(plan) || builderRan(db, plan.id)) return false
  if (!asked(`${maybe(root, plan.id, 'ask.md') ?? ''}\n${answer}`)) return false
  if (rule(db, root, { ...plan, template: 'research' }, 'director', answer) === null) return false
  db.transaction(() => {
    lanePipe(db, LANE.research.pipe)
    const pipe = pipeNamed(db, LANE.research.pipe)
    if (pipe === null) throw new Error(`no ${LANE.research.pipe} pipe`)
    toResearch(db, plan.id, pipe.id, LANE.research.seat)
  })()
  unhold(db, root, plan.id, 'director', 0)
  for (const name of ['refusal.md', 'question.md']) {
    if (maybe(root, plan.id, name) !== null) move(root, plan.id, name, name.replace('.md', '.prev.md'))
  }
  return true
}
