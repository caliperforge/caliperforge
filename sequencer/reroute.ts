import { eventsOf, logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { LANE } from '../store/lanes.ts'
import { holder } from '../store/leases.ts'
import { lanePipe } from '../store/origins.ts'
import { partOf } from '../store/parts.ts'
import { builderRan, internal, pipeNamed, planById, type PlanRow } from '../store/plans.ts'
import { clear } from '../store/refusals.ts'
import { researchParts, toBuild, toResearch } from '../store/reroute.ts'
import { labelled, measured } from '../templates/asked.ts'
import { unasked, work } from '../templates/research.ts'
import { estimate, files, TEST } from './brief.ts'
import { unhold } from './hold.ts'
import type { Outcome } from './kind.ts'
import { stray } from './rule.ts'
import { diffOf, maybe, move, put } from './workspace.ts'

const OUTPUT = '**Output:**'
export const MEASURE = '**Measure:**'
export const UNBUILT = 'the measurer needs a build'

// A part's own lines end at its first blank line; the parent's ask and comments follow, and may carry their own `**Measure:**`.
export const own = (body: string): boolean => (body.split('\n\n')[0] ?? '').includes(`\n${MEASURE}`)

function asked(text: string): boolean {
  const out = labelled(text, OUTPUT)
  return unasked(text).length === 0 && (out === undefined ? measured(text) : work(out) !== null)
}

function researchable(db: Db, root: string, plan: PlanRow, text: string): boolean {
  return plan.template === 'pr_path' && internal(plan) && plan.target_id === null
    && (!builderRan(db, plan.id) || diffOf(root, plan.id).trim() === '') && asked(text)
    && !eventsOf(db, plan.id, 'return').some((e) => e.actor === 'tick' && e.message.endsWith(UNBUILT))
}

export function moved(db: Db, root: string, id: number): void {
  db.transaction(() => {
    lanePipe(db, LANE.research.pipe)
    const pipe = pipeNamed(db, LANE.research.pipe)
    if (pipe === null) throw new Error(`no ${LANE.research.pipe} pipe`)
    toResearch(db, id, pipe.id, LANE.research.seat)
  })()
  aside(root, id)
}

export function aside(root: string, id: number): void {
  for (const name of ['refusal.md', 'question.md', 'issue.md']) {
    if (maybe(root, id, name) !== null) move(root, id, name, name.replace('.md', '.prev.md'))
  }
}

function machine(db: Db, parent: PlanRow): PlanRow {
  lanePipe(db, LANE.machine.pipe)
  const pipe = pipeNamed(db, LANE.machine.pipe)
  if (pipe === null) throw new Error(`no ${LANE.machine.pipe} pipe`)
  return { ...parent, template: LANE.machine.template, pipe_id: pipe.id, lane: 'machine', seat: LANE.machine.seat }
}

export function built(db: Db, root: string, id: number, why: string): string {
  const source = planById(db, partOf(db, id)?.parent ?? id)
  const lane = db.transaction((): string => {
    const to = source.template === 'research' ? machine(db, source) : source
    const name = to.lane ?? 'machine'
    toBuild(db, id, to, name, to.seat ?? LANE.machine.seat)
    clear(db, id)
    logged(db, { plan: id, kind: 'return', actor: 'tick', outcome: 'pass', message: `research → ${name}: ${why}`, pointer: null, run: null })
    return name
  })()
  aside(root, id)
  return lane
}

export function misrouted(db: Db, root: string, now: Date): void {
  const stray = researchParts(db).filter((r) => !own(r.body) && !measured(maybe(root, r.plan, 'ask.md') ?? '') && holder(db, r.plan, now) === null)
  for (const row of stray) built(db, root, row.plan, `its own lines carry no ${MEASURE}`)
}

/** An unbuilt pr_path plan of ours goes to the research lane at step 0, its ask carrying the research lines. */
export function rerouted(db: Db, root: string, plan: PlanRow, answer: string): boolean {
  const text = `${maybe(root, plan.id, 'ask.md') ?? ''}\n## Answer from the director (${new Date().toISOString().slice(0, 10)})\n\n${answer.trim()}\n`
  if (!researchable(db, root, plan, text) || stray(root, plan, answer) !== null) return false
  put(root, plan.id, 'ask.md', text)
  moved(db, root, plan.id)
  unhold(db, root, plan.id, 'director', 0)
  return true
}

/** The same move for a plan whose own ask already carries the research lines. */
function researched(db: Db, root: string, plan: PlanRow): boolean {
  if (!researchable(db, root, plan, maybe(root, plan.id, 'ask.md') ?? '')) return false
  moved(db, root, plan.id)
  return true
}

export function byHand(db: Db, root: string, plan: PlanRow, runs: string, brief: string | null): Outcome | null {
  if (brief === null || estimate(brief) !== 0 || (files(brief).length > 0 && files(brief).every((f) => TEST.test(f.path)))) return null
  if (researched(db, root, plan)) return { outcome: 'pass', spans: [], note: `${runs}: research ask: sent to the research lane`, rewind: 0 }
  return { outcome: 'needs_ceo', spans: ['hand-run'], note: `${runs}: hand-run brief: it estimates 0 lines, so a person runs it; held until hand-run briefs have their own route` }
}
