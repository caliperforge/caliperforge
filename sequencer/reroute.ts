import type { Db } from '../store/index.ts'
import { LANE } from '../store/lanes.ts'
import { lanePipe } from '../store/origins.ts'
import { builderRan, internal, pipeNamed, type PlanRow } from '../store/plans.ts'
import { toResearch } from '../store/reroute.ts'
import { labelled } from '../templates/asked.ts'
import { unasked, work } from '../templates/research.ts'
import { estimate, files, TEST } from './brief.ts'
import { unhold } from './hold.ts'
import type { Outcome } from './kind.ts'
import { rule } from './rule.ts'
import { maybe, move } from './workspace.ts'

const OUTPUT = '**Output:**'

function asked(text: string): boolean {
  const out = labelled(text, OUTPUT)
  return unasked(text).length === 0 && (out === undefined ? text.split('\n').some((l) => l.startsWith('**Measure:**')) : work(out) !== null)
}

function researchable(db: Db, plan: PlanRow, text: string): boolean {
  return plan.template === 'pr_path' && internal(plan) && plan.target_id === null && !builderRan(db, plan.id) && asked(text)
}

function moved(db: Db, root: string, id: number): void {
  db.transaction(() => {
    lanePipe(db, LANE.research.pipe)
    const pipe = pipeNamed(db, LANE.research.pipe)
    if (pipe === null) throw new Error(`no ${LANE.research.pipe} pipe`)
    toResearch(db, id, pipe.id, LANE.research.seat)
  })()
  for (const name of ['refusal.md', 'question.md', 'issue.md']) {
    if (maybe(root, id, name) !== null) move(root, id, name, name.replace('.md', '.prev.md'))
  }
}

/** An unbuilt pr_path plan of ours goes to the research lane at step 0, its ask carrying the research lines. */
export function rerouted(db: Db, root: string, plan: PlanRow, answer: string): boolean {
  if (!researchable(db, plan, `${maybe(root, plan.id, 'ask.md') ?? ''}\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${answer.trim()}\n`)) return false
  if (rule(db, root, { ...plan, template: 'research' }, 'director', answer) === null) return false
  moved(db, root, plan.id)
  unhold(db, root, plan.id, 'director', 0)
  return true
}

/** The same move for a plan whose own ask already carries the research lines. */
function researched(db: Db, root: string, plan: PlanRow): boolean {
  if (!researchable(db, plan, maybe(root, plan.id, 'ask.md') ?? '')) return false
  moved(db, root, plan.id)
  return true
}

export function byHand(db: Db, root: string, plan: PlanRow, runs: string, brief: string | null): Outcome | null {
  if (brief === null || estimate(brief) !== 0 || (files(brief).length > 0 && files(brief).every((f) => TEST.test(f.path)))) return null
  if (researched(db, root, plan)) return { outcome: 'pass', spans: [], note: `${runs}: research ask: sent to the research lane`, rewind: 0 }
  return { outcome: 'needs_ceo', spans: ['hand-run'], note: `${runs}: hand-run brief: it estimates 0 lines, so a person runs it; held until hand-run briefs have their own route` }
}
