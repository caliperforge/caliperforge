import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { CostWall, Fired, Provider, Range } from '../providers/kind.ts'
import { packet, real } from '../runner/index.ts'
import type { Seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { planDir } from '../sequencer/workspace.ts'
import { logged, runLogged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { observed } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import { criticCheck } from './critic.ts'
import { compiled, extract } from './extract.ts'
import { type Check, FIX, fixed, type Fixed } from './fixturn.ts'
import { costWalled } from './generated.ts'
import { handoff, layered, ranged, type Refused } from './handoff.ts'
import { drawn, excerpts, LAYERS, ranges, sections, suited } from './map.ts'
import { grader } from './missed.ts'
import { duplicated, packets, planned } from './plan.ts'
import type { Step } from './pr-path.ts'
import { readings, trackers } from './probes.ts'
import { met, reach, unlocated, unmet, written } from './reach.ts'
import { KINDS } from './report.ts'
import { callee, rows, slices } from './slices.ts'
import { packed, smoke, type Smoked, unrun } from './smoke.ts'
import { harnessed, probed, suite, unsourced } from './suite.ts'

export interface Sum { tokens: number; seconds: number; usd: number; transcripts: string[]; wall: string | null }

export type Fire = (prompt: string, issue: string, sum: Sum, phase?: string) => Promise<Sum | Outcome>

export const START: Sum = { tokens: 0, seconds: 0, usd: 0, transcripts: [], wall: null }

const SETUP = 60

const TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000' }

const FOREGROUND = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }

const ATTEMPTS = '/tmp/x-ray-attempts.md'

const TEMPLATES = 'phases/handoff/templates.md'

const MAP = 'map.md'

const EXCERPTS = 'excerpts'

export interface Bench { db: Db; root: string; plan: PlanRow; step: Step; provider: Provider; name: string; dir: string; tmp: string; granted: string[]; walls: CostWall; ceiling: number }

export function firing({ db, root, plan, step, provider, name, dir, tmp, granted, walls, ceiling }: Bench, manifest: Seat, hash: string, map?: Range[]): Fire {
  return async (prompt, issue, sum, phase) => {
    const built = packet(manifest, prompt, '', issue, dir,
      pending(planDir(root, plan.id), `step-${String(step.step)}${phase === undefined ? '' : `-${phase}`}`), false, [...manifest.write_paths, tmp])
    const fired = await provider.fire({ ...built, refuse: (path) => real(resolve(dir, path)) === real(ATTEMPTS) ? null : built.refuse(path), wall: ceiling - sum.tokens,
      cost_wall: { ...walls, usd: walls.usd - sum.usd }, env: { ...TIMEOUTS, ...FOREGROUND, TMPDIR: tmp }, reads: [...granted, real(ATTEMPTS)], offline: true, ...(map !== undefined ? { map: { ranges: map, slice: map } } : name === 'fizz_lean_generator' ? { ranged: true } : {}), ...(['fizz_generator', 'fizz_lean_generator'].includes(name) ? { idle: SETUP } : {}) })
    const run = runLogged(db, { plan: plan.id, step: step.step, seat: name, rule_hash: hash, provider: provider.name, model: manifest.model,
      effort: manifest.effort, exit: fired.exit, fired, staffed: name, phase })
    for (const command of fired.offline ?? []) logged(db, { plan: plan.id, kind: 'run.offline', actor: name, outcome: 'refuse', message: command, pointer: null, run })
    for (const { kind, file, lines } of fired.misses ?? []) logged(db, { plan: plan.id, kind, actor: name, outcome: 'pass', message: JSON.stringify({ file, line: parseInt(lines.slice(1), 10) }), pointer: null, run })
    const transcript = byRun(db, run, fired.transcript_path)
    observed(db, fired.limits)
    return added(sum, fired, transcript, phase === undefined ? name : `${name} ${phase}`, ceiling)
  }
}

function added(sum: Sum, fired: Fired, transcript: string, who: string, ceiling: number): Sum | Outcome {
  const next = { tokens: sum.tokens + fired.usage.input + fired.usage.output, seconds: sum.seconds + fired.seconds, usd: sum.usd + (fired.usage.cost ?? 0),
    transcripts: [...sum.transcripts, transcript], wall: costWalled(fired.stop_reason) }
  if (next.tokens >= ceiling) return { outcome: 'refuse', spans: ['bench.ceiling'], note: `${who} hit the ${String(ceiling)}-token ceiling at ${String(next.tokens)} tokens` }
  if (next.wall === null && fired.ended !== 'completed') return { outcome: 'refuse', spans: [fired.stop_reason ?? 'seat.exit'], note: `${who} ${fired.ended}` }
  return next
}

interface Phase { phase: string; skill: string; root: string; path: string; prompt: string; issue: string; map?: string }

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : ''

function facts({ phase, root, path, map }: Pick<Phase, 'phase' | 'root' | 'path' | 'map'>): Refused[] {
  const at = join(dirname(path), MAP)
  if (map !== undefined) return layered(phase, map, read(at))
  if (phase !== 'context' || !existsSync(join(root, 'src'))) return []
  const failed = compiled(root)
  if (failed.length > 0) return failed
  const selection = join(dirname(path), '../entry-point-selection.json')
  if (!existsSync(selection)) return [{ rule: 'handoff.map', note: `context: ${selection} is missing` }]
  const extracted = extract(root)
  const text = drawn(extracted, readFileSync(selection, 'utf8'), read(at))
  writeFileSync(at, text)
  const refused = ranged(root, text, extracted)
  if (refused.length === 0) excerpts(root, text, join(dirname(path), EXCERPTS))
  return refused
}

const listed = (refused: Refused[]): string => refused.map((r) => `- ${r.rule}: ${r.note}`).join('\n')

async function checked(fire: Fire, at: Phase, sum: Sum, refused: Refused[] = []): Promise<Sum | Outcome> {
  const issue = refused.length === 0 ? at.issue : `${at.issue}\nYour handoff was refused:\n${listed(refused)}`
  const ran = await fire(at.prompt, issue, sum, at.phase)
  if ('outcome' in ran || ran.wall !== null) return ran
  const handed = [...handoff(at.skill, at.phase, read(at.path)), ...facts(at)]
  if (handed.length === 0) return ran
  if (listed(handed) !== listed(refused)) return checked(fire, at, ran, handed)
  return { outcome: 'needs_coo', spans: [...new Set(handed.map((r) => r.rule))], note: `${at.phase} handoff refused twice on the same span`,
    message: `Refused:\n${listed(refused)}\n\nRefused again:\n${listed(handed)}` }
}

const FACTS = ['Limits', 'Outside dependencies', 'Conversion points']

function fixing(bench: Bench, manifest: Seat, hash: string, handoffs: string, phase: string, sum: Sum) {
  const { db, plan, name, dir } = bench
  const at = { fire: firing(bench, { ...manifest, ...FIX }, hash), dir, handoffs }
  const fixes = {
    sum,
    log: (kind: string, outcome: 'pass' | 'refuse', message: string): void => { logged(db, { plan: plan.id, kind, actor: name, outcome, message, pointer: null, run: null }) },
    fix: async (check: Check): Promise<Fixed | Sum | Outcome> => {
      const got = await fixed(at, check, phase, fixes.sum)
      if ('outcome' in got || got.sum.wall !== null) return 'outcome' in got ? got : got.sum
      for (const row of got.turns) fixes.log(KINDS.fix_turns, 'pass', JSON.stringify(row))
      if (got.not_clean !== null) fixes.log(KINDS.critic, 'refuse', got.not_clean)
      fixes.sum = got.sum
      return got
    },
  }
  return fixes
}

function rebuilt(root: string, phase: string, check: () => Refused[]): Refused[] {
  const broken = compiled(root, phase)
  return broken.length > 0 ? broken : check()
}

const machine = (skill: string, phase: string): string => read(join(skill, `phases/${phase}.md`)).split('\n').filter((l) => l.startsWith('- The machine')).join('\n')

async function scaffolded(bench: Bench, manifest: Seat, hash: string, skill: string, root: string, handoffs: string, sum: Sum): Promise<{ sum: Sum; smoked: string } | Sum | Outcome> {
  const [map, fizz] = [join(handoffs, MAP), bench.granted.find((path) => basename(path) === 'fizz') ?? '']
  const fixes = fixing(bench, manifest, hash, handoffs, 'scaffold', sum)
  const { log, fix } = fixes
  const rules = machine(skill, 'scaffold')
  const facts = sections(read(map)).filter(([section]) => FACTS.includes(section)).map(([, s]) => s.trimEnd()).join('\n\n')
  let [lines, last]: [string[], Smoked[]] = [[], []]
  const built = await fix({ name: 'suite', rules, facts, run: () => rebuilt(root, 'scaffold', () => {
    const found = suite(root)
    writeFileSync(map, suited(found, read(map)))
    lines = unsourced(found, read(map))
    return [...harnessed(found, read(map)), ...probed(found, read(map))]
  }) })
  if (!('turns' in built)) return built
  for (const line of lines) log('suite.unsourced', 'pass', line)
  let hung = null as Refused | null
  const ran = built.not_clean === null ? await fix({ name: 'smoke', rules, facts, run: () => rebuilt(root, 'smoke', () => {
    const got = smoke(root, fizz, 'test/fizz/fizz_data', read(map))
    if (!('rule' in got)) return unrun(read(map), last = got)
    hung = got
    return []
  }) }) : built
  if (!('turns' in ran)) return ran
  if (hung !== null) {
    log(hung.rule, 'refuse', hung.note)
    return { outcome: 'refuse', spans: [hung.rule], note: hung.note }
  }
  const stood = await fix(criticCheck(join(fizz, 'references/critic-pass.md'), bench.dir, 'critic.stand_in', read(map)))
  return 'turns' in stood ? { sum: fixes.sum, smoked: packed(last) } : stood
}

async function reached(bench: Bench, manifest: Seat, hash: string, skill: string, root: string, handoffs: string, sum: Sum): Promise<Sum | Outcome> {
  const [map, corpus] = [join(handoffs, MAP), join(handoffs, '../corpus_medusa')]
  const [broken] = compiled(root, 'coverage')
  if (broken !== undefined) return { outcome: 'refuse', spans: [broken.rule], note: broken.note }
  const items = reach(root, read(map), join(corpus, 'coverage/lcov.info'), join(corpus, 'coverage/revert_report.json'), readings(suite(root).probes, trackers(root, corpus)))
  writeFileSync(map, written(read(map), items))
  const [lost] = unlocated(items)
  if (lost !== undefined) return { outcome: 'refuse', spans: [lost.rule], note: lost.note }
  const fixes = fixing(bench, manifest, hash, handoffs, 'coverage', sum)
  const got = await fixes.fix({ name: 'reach', rules: machine(skill, 'coverage'), facts: '', run: () => unmet(read(map), items).map((i) => ({ rule: 'reach.unmet', note: i.note })) })
  if (!('turns' in got)) return got
  const left = met(read(map), items)
  fixes.log(KINDS.reach, left.met ? 'pass' : 'refuse', JSON.stringify(left))
  return fixes.sum
}

async function criticised(bench: Bench, manifest: Seat, hash: string, handoffs: string, phase: string, rule: string, sum: Sum): Promise<Sum | Outcome> {
  const fizz = bench.granted.find((path) => basename(path) === 'fizz') ?? ''
  const fixes = fixing(bench, manifest, hash, handoffs, phase, sum)
  const got = await fixes.fix(criticCheck(join(fizz, 'references/critic-pass.md'), bench.dir, rule, read(join(handoffs, MAP))))
  if (!('turns' in got)) return got
  if (got.not_clean === null) fixes.log(KINDS.critic, 'pass', rule)
  return fixes.sum
}

const ending = ({ path, phase, skill }: Pick<Phase, 'path' | 'phase' | 'skill'>): string => `Before you end, write ${path} filled from the \`# Handoff: ${phase}\` block of ${join(skill, TEMPLATES)}.`

const LAID = LAYERS.filter(([layer]) => ['suite', 'reach'].includes(layer)).flatMap(([, names]) => names)

const ENTRY = 'Selected entry points '

async function invariant(bench: Bench, manifest: Seat, hash: string, skill: string, root: string, handoffs: string, at: Phase, sum: Sum): Promise<Sum | Outcome> {
  const [map, cut, plan, reports] = [join(handoffs, MAP), join(handoffs, EXCERPTS), join(handoffs, 'plan.md'), join(handoffs, '../reports')]
  slices(read(map), cut, sections(read(map)).filter(([name]) => LAID.includes(name)).map(([, s]) => s.trimEnd()).join('\n\n'), join(reports, 'slices'))
  const fire = firing(bench, manifest, hash, ranges(read(map)))
  const planning = `Run Steps 9a-9c only, and end once the Synthesizer has written ${plan} from the \`# Plan\` block of ${join(skill, TEMPLATES)}.`
  const first = await fire(at.prompt, at.issue.replace(ending(at), planning), sum, 'invariants-plan')
  if ('outcome' in first || first.wall !== null) return first
  const [broken] = compiled(root, 'invariants')
  if (broken !== undefined) return { outcome: 'refuse', spans: [broken.rule], note: broken.note }
  const found = suite(root)
  const names = [...found.trackers, ...found.handlers].map((t) => t.name)
  const unreached = (rows(read(map)).get('Reach') ?? []).filter((r) => r.name.startsWith(ENTRY) && r.cells.get('met') === 'no').map((r) => callee(r.name.slice(ENTRY.length)))
  const fixes = fixing(bench, manifest, hash, handoffs, 'invariants', first)
  const got = await fixes.fix({ name: 'synthesizer', rules: machine(skill, 'invariants'), facts: '', run: () => planned(read(plan), read(map), names, unreached).refused })
  if (!('turns' in got)) return got
  for (const name of planned(read(plan), read(map), names, unreached).flagged) fixes.log('plan.flagged', 'pass', name)
  const fizz = bench.granted.find((path) => basename(path) === 'fizz') ?? ''
  const { global, specific } = packets(read(plan), read(map), cut, read(join(fizz, 'references/property-generation.md')), names)
  const leg: Phase = { ...at, map: read(map), issue: [at.issue, 'Run Steps 9d-9e.', `## Global packet\n\n${global}`, `## Specific packet\n\n${specific}`].join('\n') }
  const ran = await checked(fire, leg, fixes.sum)
  if ('outcome' in ran || ran.wall !== null) return ran
  const doubled = (): Refused[] => duplicated(read(join(reports, 'invariants-global-property-implementer.md')), read(join(reports, 'invariants-specific-property-implementer.md')))
  const hits = doubled()
  if (hits.length === 0) return ran
  const again = await checked(fire, leg, ran, hits)
  if ('outcome' in again || again.wall !== null) return again
  for (const hit of doubled()) fixes.log('plan.duplicate', 'refuse', hit.note)
  return again
}

function rechecked(skill: string, root: string, handoffs: string, phase: string): Outcome | null {
  const path = join(handoffs, `${phase}.md`)
  const map = phase !== 'context' && existsSync(join(handoffs, EXCERPTS)) ? { map: read(join(handoffs, MAP)) } : {}
  const refused = [...handoff(skill, phase, read(path)), ...facts({ phase, root, path, ...map })]
  if (refused.length === 0) return null
  return { outcome: 'refuse', spans: [...new Set(refused.map((r) => r.rule))], note: `${phase} handoff refused on resume: ${refused.map((r) => r.note).join('; ')}` }
}

async function ended(bench: Bench, manifest: Seat, hash: string, handoffs: string, stopped: string, sum: Sum): Promise<Sum | Outcome> {
  const got = await criticised(bench, manifest, hash, handoffs, 'end', 'critic.stand_in', sum)
  if (!('outcome' in got)) rmSync(stopped, { force: true })
  return got
}

export function phasesOf(skill: string): string[] {
  return [...readFileSync(join(skill, TEMPLATES), 'utf8').matchAll(/^# Handoff: (.+)$/gm)].map((m) => m[1] ?? '').filter((phase) => phase !== 'campaigns')
}

export async function phased(bench: Bench, manifest: Seat, hash: string, skill: string, handoffs: string, issue: string, stop?: string): Promise<Sum | Outcome> {
  const phases = phasesOf(skill)
  const root = resolve(handoffs, '../../../..')
  const stopped = join(handoffs, 'stopped.json')
  const [map, cut] = [join(handoffs, MAP), join(handoffs, EXCERPTS)]
  const resumed = existsSync(stopped) ? JSON.parse(readFileSync(stopped, 'utf8')) as { phase: string; sum: Sum; smoked: string } : null
  const refused = resumed === null ? null : rechecked(skill, root, handoffs, resumed.phase)
  if (refused !== null) return refused
  const done = resumed === null ? -1 : phases.indexOf(resumed.phase)
  let [sum, smoked] = [resumed?.sum ?? START, resumed?.smoked ?? '']
  const grade = grader(bench, root)
  for (const [at, phase] of phases.entries()) {
    if (at <= done) continue
    const path = join(handoffs, `${phase}.md`)
    const start = at === 0 ? [] : [`Start from ${join(handoffs, `${phases[at - 1] ?? ''}.md`)}.`]
    const later = phase !== 'context' && existsSync(cut)
    const named = later ? [`Read ${map} and the excerpts it cites: ${readdirSync(cut).map((f) => join(cut, f)).join(', ')}.`] : []
    const fire = firing(bench, manifest, hash, later ? ranges(read(map)) : undefined)
    const stage: Phase = { phase, skill, root, path, prompt: readFileSync(join(skill, 'phases', `${phase}.md`), 'utf8'), ...(later ? { map: read(map) } : {}),
      issue: [issue, ending({ path, phase, skill }), ...start, ...named, ...(phase === 'coverage' && smoked !== '' ? [smoked] : [])].join('\n') }
    const ran = phase === 'invariants' && later ? await invariant(bench, manifest, hash, skill, root, handoffs, stage, sum) : await checked(fire, stage, sum)
    if ('outcome' in ran || ran.wall !== null) return ran
    sum = ran
    if (phase === 'scaffold' && later) {
      const repaired = await scaffolded(bench, manifest, hash, skill, root, handoffs, sum)
      if (!('smoked' in repaired)) return repaired
      ;({ sum, smoked } = repaired)
    }
    if ((phase === 'coverage' && later) || phase === 'invariants') {
      const got = phase === 'coverage' ? await reached(bench, manifest, hash, skill, root, handoffs, sum) : await criticised(bench, manifest, hash, handoffs, phase, 'critic.share_converted', sum)
      if ('outcome' in got || got.wall !== null) return got
      sum = got
    }
    const miss = grade(phase, sum)
    if (miss !== null) return miss
    writeFileSync(stopped, JSON.stringify({ phase, sum, smoked }))
    if (phase === stop) return { outcome: 'pass', held: true, spans: ['bench.stop_after'], note: `stopped after ${phase} for a look` }
  }
  return ended(bench, manifest, hash, handoffs, stopped, sum)
}
