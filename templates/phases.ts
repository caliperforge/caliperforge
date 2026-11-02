import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { compiled, extract } from './extract.ts'
import { costWalled } from './generated.ts'
import { handoff, layered, ranged, type Refused } from './handoff.ts'
import { drawn, excerpts, ranges } from './map.ts'
import type { Step } from './pr-path.ts'

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

interface Phase { phase: string; skill: string; root: string; path: string; prompt: string; issue: string; critics: () => Refused[]; map?: string }

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : ''

function facts({ phase, root, path, map }: Phase): Refused[] {
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

async function checked(fire: Fire, at: Phase, sum: Sum, refused: Refused[] = []): Promise<Sum | Outcome> {
  const issue = refused.length === 0 ? at.issue : `${at.issue}\nYour handoff was refused:\n${refused.map((r) => `- ${r.rule}: ${r.note}`).join('\n')}`
  const ran = await fire(at.prompt, issue, sum, at.phase)
  if ('outcome' in ran || ran.wall !== null) return ran
  const handed = [...handoff(at.skill, at.phase, read(at.path)), ...facts(at)]
  const found = handed.length === 0 && at.phase === 'invariants' ? at.critics() : handed
  if (found.length > 0 && refused.length === 0) return checked(fire, at, ran, found)
  if (handed.length > 0) return { outcome: 'refuse', spans: [...new Set(handed.map((r) => r.rule))], note: `${at.phase} handoff refused twice: ${handed.map((r) => r.note).join('; ')}` }
  if (at.phase === 'invariants') writeFileSync(join(dirname(at.path), 'critic.md'), found.map((r) => `${r.rule}: ${r.note}\n`).join(''))
  return ran
}

export function phasesOf(skill: string): string[] {
  return [...readFileSync(join(skill, TEMPLATES), 'utf8').matchAll(/^# Handoff: (.+)$/gm)].map((m) => m[1] ?? '').filter((phase) => phase !== 'campaigns')
}

export async function phased(bench: Bench, manifest: Seat, hash: string, skill: string, handoffs: string, issue: string, critics: () => Refused[], stop?: string): Promise<Sum | Outcome> {
  const phases = phasesOf(skill)
  const root = resolve(handoffs, '../../../..')
  const stopped = join(handoffs, 'stopped.json')
  const [map, cut] = [join(handoffs, MAP), join(handoffs, EXCERPTS)]
  const resumed = existsSync(stopped) ? JSON.parse(readFileSync(stopped, 'utf8')) as { phase: string; sum: Sum } : null
  rmSync(stopped, { force: true })
  const done = resumed === null ? -1 : phases.indexOf(resumed.phase)
  let sum = resumed?.sum ?? START
  for (const [at, phase] of phases.entries()) {
    if (at <= done) continue
    const path = join(handoffs, `${phase}.md`)
    const start = at === 0 ? [] : [`Start from ${join(handoffs, `${phases[at - 1] ?? ''}.md`)}.`]
    const later = phase !== 'context' && existsSync(cut)
    const named = later ? [`Read ${map} and the excerpts it cites: ${readdirSync(cut).map((f) => join(cut, f)).join(', ')}.`] : []
    const fire = firing(bench, manifest, hash, later ? ranges(read(map)) : undefined)
    const ran = await checked(fire, { phase, skill, root, path, critics, prompt: readFileSync(join(skill, 'phases', `${phase}.md`), 'utf8'), ...(later ? { map: read(map) } : {}),
      issue: [issue, `Before you end, write ${path} filled from the \`# Handoff: ${phase}\` block of ${join(skill, TEMPLATES)}.`, ...start, ...named].join('\n') }, sum)
    if ('outcome' in ran || ran.wall !== null) return ran
    sum = ran
    if (phase === stop) {
      writeFileSync(stopped, JSON.stringify({ phase, sum }))
      return { outcome: 'pass', held: true, spans: ['bench.stop_after'], note: `stopped after ${phase} for a look` }
    }
  }
  return sum
}
