import type { Db } from '../store/index.ts'
import { LANE } from '../store/lanes.ts'
import { lanePipe } from '../store/origins.ts'
import { builderRan, internal, pipeNamed, type PlanRow } from '../store/plans.ts'
import { toResearch } from '../store/reroute.ts'
import { labelled } from '../templates/asked.ts'
import { unasked, work } from '../templates/research.ts'
import { unhold } from './hold.ts'
import { rule } from './rule.ts'
import { maybe, move } from './workspace.ts'

const OUTPUT = '**Output:**'

function asked(text: string): boolean {
  const out = labelled(text, OUTPUT)
  return unasked(text).length === 0 && (out === undefined ? text.split('\n').some((l) => l.startsWith('**Measure:**')) : work(out) !== null)
}

/** An unbuilt pr_path plan of ours goes to the research lane at step 0, its ask carrying the research lines. */
export function rerouted(db: Db, root: string, plan: PlanRow, answer: string): boolean {
  if (plan.template !== 'pr_path' || !internal(plan) || plan.target_id !== null || builderRan(db, plan.id)) return false
  if (!asked(`${maybe(root, plan.id, 'ask.md') ?? ''}\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${answer.trim()}\n`)) return false
  if (rule(db, root, { ...plan, template: 'research' }, 'director', answer) === null) return false
  db.transaction(() => {
    lanePipe(db, LANE.research.pipe)
    const pipe = pipeNamed(db, LANE.research.pipe)
    if (pipe === null) throw new Error(`no ${LANE.research.pipe} pipe`)
    toResearch(db, plan.id, pipe.id, LANE.research.seat)
  })()
  unhold(db, root, plan.id, 'director', 0)
  for (const name of ['refusal.md', 'question.md', 'issue.md']) {
    if (maybe(root, plan.id, name) !== null) move(root, plan.id, name, name.replace('.md', '.prev.md'))
  }
  return true
}
