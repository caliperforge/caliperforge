import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CostWall, Fired, Provider } from '../providers/kind.ts'
import { packet, real } from '../runner/index.ts'
import type { Seat } from '../runner/rules.ts'
import type { Outcome } from '../sequencer/kind.ts'
import { planDir } from '../sequencer/workspace.ts'
import { logged, runLogged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { observed } from '../store/lanes.ts'
import type { PlanRow } from '../store/plans.ts'
import { byRun, pending } from '../store/transcript.ts'
import { costWalled } from './generated.ts'
import { handoff, type Refused } from './handoff.ts'
import type { Step } from './pr-path.ts'

export interface Sum { tokens: number; seconds: number; usd: number; transcripts: string[]; wall: string | null }

export type Fire = (prompt: string, issue: string, sum: Sum, phase?: string) => Promise<Sum | Outcome>

export const START: Sum = { tokens: 0, seconds: 0, usd: 0, transcripts: [], wall: null }

const SETUP = 60

const TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: '1800000', BASH_MAX_TIMEOUT_MS: '1800000' }

const FOREGROUND = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }

const ATTEMPTS = '/tmp/x-ray-attempts.md'

const TEMPLATES = 'phases/handoff/templates.md'

interface Bench { db: Db; root: string; plan: PlanRow; step: Step; provider: Provider; name: string; dir: string; tmp: string; granted: string[]; walls: CostWall; ceiling: number }

export function firing({ db, root, plan, step, provider, name, dir, tmp, granted, walls, ceiling }: Bench, manifest: Seat, hash: string): Fire {
  return async (prompt, issue, sum, phase) => {
    const built = packet(manifest, prompt, '', issue, dir,
      pending(planDir(root, plan.id), `step-${String(step.step)}${phase === undefined ? '' : `-${phase}`}`), false, [...manifest.write_paths, tmp])
    const fired = await provider.fire({ ...built, refuse: (path) => real(resolve(dir, path)) === real(ATTEMPTS) ? null : built.refuse(path), wall: ceiling - sum.tokens,
      cost_wall: { ...walls, usd: walls.usd - sum.usd }, env: { ...TIMEOUTS, ...FOREGROUND, TMPDIR: tmp }, reads: [...granted, real(ATTEMPTS)], offline: true, ...(name === 'fizz_lean_generator' ? { ranged: true } : {}), ...(['fizz_generator', 'fizz_lean_generator'].includes(name) ? { idle: SETUP } : {}) })
    const run = runLogged(db, { plan: plan.id, step: step.step, seat: name, rule_hash: hash, provider: provider.name, model: manifest.model,
      effort: manifest.effort, exit: fired.exit, fired, staffed: name, phase })
    for (const command of fired.offline ?? []) logged(db, { plan: plan.id, kind: 'run.offline', actor: name, outcome: 'refuse', message: command, pointer: null, run })
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

interface Phase { phase: string; skill: string; path: string; prompt: string; issue: string; critics: () => Refused[] }

async function checked(fire: Fire, at: Phase, sum: Sum, refused: Refused[] = []): Promise<Sum | Outcome> {
  const issue = refused.length === 0 ? at.issue : `${at.issue}\nYour handoff was refused:\n${refused.map((r) => `- ${r.rule}: ${r.note}`).join('\n')}`
  const ran = await fire(at.prompt, issue, sum, at.phase)
  if ('outcome' in ran || ran.wall !== null) return ran
  const handed = handoff(at.skill, at.phase, existsSync(at.path) ? readFileSync(at.path, 'utf8') : '')
  const found = handed.length === 0 && at.phase === 'invariants' ? at.critics() : handed
  if (found.length > 0 && refused.length === 0) return checked(fire, at, ran, found)
  if (handed.length > 0) return { outcome: 'refuse', spans: [...new Set(handed.map((r) => r.rule))], note: `${at.phase} handoff refused twice: ${handed.map((r) => r.note).join('; ')}` }
  if (at.phase === 'invariants') writeFileSync(join(dirname(at.path), 'critic.md'), found.map((r) => `${r.rule}: ${r.note}\n`).join(''))
  return ran
}

export async function phased(fire: Fire, skill: string, handoffs: string, issue: string, critics: () => Refused[]): Promise<Sum | Outcome> {
  const phases = [...readFileSync(join(skill, TEMPLATES), 'utf8').matchAll(/^# Handoff: (.+)$/gm)].map((m) => m[1] ?? '').filter((phase) => phase !== 'campaigns')
  let sum = START
  for (const [at, phase] of phases.entries()) {
    const path = join(handoffs, `${phase}.md`)
    const start = at === 0 ? [] : [`Start from ${join(handoffs, `${phases[at - 1] ?? ''}.md`)}.`]
    const ran = await checked(fire, { phase, skill, path, critics, prompt: readFileSync(join(skill, 'phases', `${phase}.md`), 'utf8'),
      issue: [issue, `Before you end, write ${path} filled from the \`# Handoff: ${phase}\` block of ${join(skill, TEMPLATES)}.`, ...start].join('\n') }, sum)
    if ('outcome' in ran || ran.wall !== null) return ran
    sum = ran
  }
  return sum
}
