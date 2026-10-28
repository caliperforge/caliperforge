import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Fired, Provider } from '../providers/kind.ts'
import { logged, runLogged } from '../store/events.ts'
import { type Db, rules } from '../store/index.ts'
import { alive } from '../store/leases.ts'
import { planById, type PlanRow } from '../store/plans.ts'
import { cost } from '../store/transcript.ts'
import { mapOf } from './steps.ts'
import { planDir } from './workspace.ts'

interface Proc {
  pid: number
  ppid: number
  command: string
}

const PENDING = /^step-(\d+)\.pending\.transcript\.jsonl$/

const Noted = z.object({ seat: z.string(), model: z.string(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) })

const Turn = z.object({
  type: z.literal('assistant'),
  message: z.object({
    id: z.string().optional(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
      cache_creation: z.object({ ephemeral_1h_input_tokens: z.number().nullish() }).nullish(),
    }),
  }),
})

type Used = z.infer<typeof Turn>['message']['usage']

function noteOf(transcript: string): string {
  return transcript.replace(/\.transcript\.jsonl$/, '.packet.json')
}

/** A dead lap leaves only its transcript; the packet beside it names who the lap fired, so its spend can still be recorded. */
export function noting(provider: Provider): Provider {
  return {
    ...provider,
    fire: (packet) => {
      mkdirSync(dirname(packet.transcript), { recursive: true })
      writeFileSync(noteOf(packet.transcript), JSON.stringify({ seat: packet.seat, model: packet.model, effort: packet.effort }))
      return provider.fire(packet)
    },
  }
}

/** Kills the lap a lease was taken over from, and every process under it, before this lap steps the plan. */
export function evict(db: Db, root: string, plan: number, stole: number): void {
  const said = verdict(plan, stole)
  const message = `took over pid ${String(stole)}: ${said}`
  logged(db, { plan, kind: 'steal', actor: 'tick', outcome: 'pass', message, pointer: null, run: null })
  process.stderr.write(`plan ${String(plan)} ${message}\n`)
  if (said === 'dead') buried(db, root, planById(db, plan), stole)
}

/** Each pending step transcript the dead lap left is kept under its pid, so the requeued step does not overwrite it. */
function buried(db: Db, root: string, plan: PlanRow, stole: number): void {
  const dir = planDir(root, plan.id)
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const step = PENDING.exec(name)?.[1]
    if (step === undefined) continue
    const dead = join(dir, `step-${step}.dead-${String(stole)}.transcript.jsonl`)
    renameSync(join(dir, name), dead)
    const note = join(dir, `step-${step}.pending.packet.json`)
    if (existsSync(note)) charged(db, plan, Number(step), dead, note)
  }
}

function charged(db: Db, plan: PlanRow, step: number, dead: string, note: string): void {
  const { seat, model, effort } = Noted.parse(JSON.parse(readFileSync(note, 'utf8')))
  const hash = rules(db).find((r) => r.id === seat)?.content_hash
  if (hash === undefined) throw new Error(`seat "${seat}" has no rules row`)
  const seconds = Math.max(0, (statSync(dead).mtimeMs - statSync(note).mtimeMs) / 1000)
  runLogged(db, { plan: plan.id, step, seat, rule_hash: hash, provider: 'claude-agent-sdk', model, effort, exit: 1,
    fired: { usage: usage(dead), seconds, transcript_path: dead }, mode: mapOf(plan.template).at(step).mode })
}

/** One turn per message id, at its largest, summed as a finished run's `modelUsage` is. */
function usage(path: string): Fired['usage'] {
  const turns = new Map<string, Used>()
  readFileSync(path, 'utf8').split('\n').slice(0, -1).forEach((line, n) => {
    const message = line === '' ? undefined : Turn.safeParse(JSON.parse(line)).data?.message
    if (message === undefined) return
    const id = message.id ?? `line-${String(n)}`
    const prior = turns.get(id)
    if (prior === undefined || size(message.usage) > size(prior)) turns.set(id, message.usage)
  })
  const sum = { input: 0, cache: 0, write: 0, write_1h: 0, output: 0 }
  for (const u of turns.values()) {
    const write = u.cache_creation_input_tokens ?? 0
    sum.input += u.input_tokens + write
    sum.cache += u.cache_read_input_tokens ?? 0
    sum.write += write
    sum.write_1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    sum.output += u.output_tokens
  }
  const figure = cost(path)
  return figure === null ? sum : { ...sum, cost: figure }
}

function size(u: Used): number {
  return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + u.output_tokens
}

function verdict(plan: number, stole: number): string {
  if (!alive(stole)) return 'dead'
  const procs = ps()
  const holder = procs.find((p) => p.pid === stole)
  if (holder === undefined || !new RegExp(`\\blap ${String(plan)}\\b`).test(holder.command)) {
    return `alive, not a lap of plan ${String(plan)}`
  }
  const tree = [stole]
  for (const pid of tree) tree.push(...procs.filter((p) => p.ppid === pid).map((p) => p.pid))
  return `alive, killed ${String(tree.filter(kill).length)} processes`
}

function ps(): Proc[] {
  const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`ps exited ${String(out.status)}: ${out.stderr}`)
  return out.stdout.split('\n').flatMap((line) => {
    const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line) ?? []
    return command === undefined ? [] : [{ pid: Number(pid), ppid: Number(ppid), command }]
  })
}

function kill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false
    throw error
  }
}
