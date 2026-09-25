import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { query, type HookInput, type SDKMessage, type SDKRateLimitInfo, type SDKResultMessage, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Reading } from '../../store/lanes.ts'
import { credential } from '../credential.ts'
import { bare, type Fired, type Packet, type Provider } from '../kind.ts'

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit'])

const READS = new Set(['Read', 'Glob', 'Grep'])

/** A builder that has taken this many model turns and written nothing is reading, not building. */
export const IDLE_TURNS = 20

/** The `Bash(<pattern>)` entries of a tool list. A seat that names none may run no command. */
const RULE = /^Bash\((.+)\)$/

/** Chaining, substitution and redirection reach a second command the pattern never admitted. */
const CHAINED = /[;&|`$<>\n()]/

export const claudeAgentSdk: Provider = { name: 'claude-agent-sdk', fire }

async function fire(packet: Packet): Promise<Fired> {
  const started = Date.now()
  const refused: string[] = []
  const limits: Reading[] = []
  const spent = new Map<string, number>()
  const pace = { turns: new Set<string>(), wrote: false }
  const transcript = openTranscript(packet)
  const run = query({
    prompt: packet.prompt,
    options: {
      cwd: packet.cwd,
      env: credential().env,
      model: packet.model,
      effort: packet.effort,
      tools: offered(packet.tools),
      allowedTools: packet.tools,
      ...(packet.steps === undefined ? {} : { maxTurns: packet.steps }),
      settingSources: [],
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [(input) => {
        const over = walled(packet.wall, total(spent)) ?? idle(packet.tools, pace.wrote, pace.turns.size)
        const decision = over === null ? gate(packet, input) : stop(over)
        if (decision.continue && writing(input)) pace.wrote = true
        if (decision.stopReason !== undefined) refused.push(decision.stopReason)
        return Promise.resolve(decision)
      }] }] },
    },
  })
  for await (const message of run) {
    transcript(message)
    if (message.type === 'assistant') {
      const id = (message.message as { id?: string }).id ?? `turn-${String(pace.turns.size)}`
      pace.turns.add(id)
      spent.set(id, Math.max(spent.get(id) ?? 0, turn(message)))
    }
    if (message.type === 'rate_limit_event') limits.push(...readings(message.rate_limit_info, new Date().toISOString()))
    if (message.type === 'result') return { ...fired(message, started, refused), limits, transcript_path: packet.transcript }
  }
  throw new Error('claude-agent-sdk closed without a result message')
}

/**
 * #148: the wall is read before the tool call that would feed another turn to the model, never after the
 * bill. A runaway run is tool-driven, so this is the seam every extra turn passes through; a run that spends
 * its wall inside one turn still stops at the next one, which is the earliest any brake can act.
 */
export function walled(wall: number | undefined, spent: number): string | null {
  if (wall === undefined || spent < wall) return null
  return `ruling:run.token_wall stopped the run at ${million(spent)} tokens, past the ${million(wall)} wall`
}

/**
 * A builder that has spent `IDLE_TURNS` turns without one write stops, before the wall would catch it: on
 * 09-24 two surfpool fires read a dependency for 23 turns each and wrote nothing. Seats without Write never trip.
 */
export function idle(tools: string[], wrote: boolean, turns: number): string | null {
  if (wrote || turns < IDLE_TURNS || !tools.some((t) => WRITES.has(bare(t)))) return null
  return `ruling:run.idle stopped the run after ${String(turns)} turns with nothing written`
}

function writing(input: HookInput): boolean {
  return input.hook_event_name === 'PreToolUse' && WRITES.has(input.tool_name)
}

/** What a turn adds against the wall. CEO 09-24: cache reads are recorded, never capped. */
/**
 * The SDK sends one assistant message per content block, each carrying the whole turn's usage under the same
 * message id. Summed per message, a turn counted three or four times over, and the 0.4M wall stopped runs
 * that had spent about 0.1M (plans 85 and 94, 09-24). One turn is one id, counted once, at its largest.
 */
function total(spent: Map<string, number>): number {
  let sum = 0
  for (const tokens of spent.values()) sum += tokens
  return sum
}

function turn(message: SDKMessage & { type: 'assistant' }): number {
  const used = message.message.usage
  return used.input_tokens + (used.cache_creation_input_tokens ?? 0) + used.output_tokens
}

function million(n: number): string {
  return `${(n / 1e6).toFixed(1)}M`
}

const WINDOWS = ['five_hour', 'seven_day'] as const

type Unified = Partial<Record<string, { utilization?: number; resetsAt?: number }>>

/**
 * The windows one rate-limit event reports (#104). The event names one window and its status; the CLI also
 * sends `unifiedWindows` with both, and a window other than the named one is `allowed` until it is full.
 */
export function readings(info: SDKRateLimitInfo, at: string): Reading[] {
  const unified = (info as { unifiedWindows?: Unified }).unifiedWindows ?? {}
  return WINDOWS.flatMap((kind): Reading[] => {
    const own = info.rateLimitType === kind
    const utilization = (own ? info.utilization : undefined) ?? unified[kind]?.utilization
    const resets = (own ? info.resetsAt : undefined) ?? unified[kind]?.resetsAt
    if (utilization === undefined || resets === undefined) return []
    const status = own ? info.status : utilization >= 1 ? 'rejected' : 'allowed'
    return [{ observed_at: at, rate_limit_type: kind, resets_at: resets, status, utilization }]
  })
}

/**
 * What the session is offered, as against `allowedTools`, which only auto-approves.
 * A seat that never names `Bash(…)` never sees Bash, so it cannot open on a command the gate must refuse.
 */
export function offered(tools: string[]): string[] {
  return [...new Set(tools.map(bare))]
}

/** The stream as it arrived, one JSON message per line, before any reading of it. */
function openTranscript(packet: Packet): (message: unknown) => void {
  mkdirSync(dirname(packet.transcript), { recursive: true })
  writeFileSync(packet.transcript, '')
  return (message) => { appendFileSync(packet.transcript, `${JSON.stringify(message)}\n`) }
}

/**
 * A write outside the fence ends the step. A command outside the seat's list is refused and the seat goes on
 * with its other tools: once a builder held `npm`, a `grep` it reached for ended the whole build (plan 62, 09-21).
 */
export function gate(packet: Packet, input: HookInput): SyncHookJSONOutput {
  if (input.hook_event_name !== 'PreToolUse') return { continue: true }
  if (input.tool_name === 'Bash') {
    const refused = ranOutside(packet.tools, input.tool_input)
    return refused === null ? { continue: true } : deny(refused)
  }
  const away = readOutside(packet.cwd, input.tool_name, input.tool_input, packet.reads)
  if (away !== null) return deny(away)
  const denied = wroteOutside(packet, input.tool_name, input.tool_input)
  return denied === null ? { continue: true } : stop(denied)
}

/**
 * A read outside the checkout is refused and the seat goes on: what it needs from a dependency is in the
 * brief's Settled facts. The registry dig this stops cost two surfpool fires their whole wall on 09-24.
 */
export function readOutside(cwd: string, tool: string, args: unknown, reads: string[] = []): string | null {
  if (!READS.has(tool)) return null
  const given = args as { file_path?: unknown; path?: unknown }
  const path = typeof given.file_path === 'string' ? given.file_path : typeof given.path === 'string' ? given.path : null
  if (path === null) return null
  const target = real(resolve(cwd, path))
  if (SPILLED.test(target)) return null
  const rel = relative(real(resolve(cwd)), target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return null
  if (reads.some((dir) => within(real(resolve(dir)), target))) return null
  return `ruling:run.outside_checkout refuses a read of ${path}: read nothing outside the checkout; the brief's Settled facts hold what the change needs from outside it`
}

function within(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Where the harness spills a tool result too long to hand back inline; the seat reads its own output there. */
const SPILLED = /\/\.claude\/projects\/[^/]+\/[^/]+\/tool-results\//

/**
 * The tick runs from a worktree whose `.cf` is a symlink, so a seat's cwd and the paths it reads can name
 * one checkout two ways. Both sides are compared as the disk resolves them; a path not yet on disk
 * resolves through its nearest existing parent.
 */
function real(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(real(parent), basename(path))
}

function wroteOutside(packet: Packet, tool: string, args: unknown): string | null {
  if (!WRITES.has(tool)) return null
  const path = (args as { file_path?: unknown }).file_path
  if (typeof path !== 'string') return null
  const refusal = packet.refuse(path)
  return refusal === null ? null : `${refusal.origin_kind}:${refusal.origin_ref} refuses a write to ${refusal.path}`
}

function ranOutside(tools: string[], args: unknown): string | null {
  const given = args as { command?: unknown; run_in_background?: unknown }
  if (given.run_in_background === true) return 'ruling:seat.tools refuses run_in_background: call Bash again without it and wait for the output'
  const said = given.command
  const command = typeof said === 'string' ? said.trim() : ''
  const patterns = tools.flatMap((tool) => RULE.exec(tool)?.[1] ?? [])
  if (!CHAINED.test(command) && patterns.some((pattern) => admits(pattern, command))) return null
  return `ruling:seat.tools refuses the command ${JSON.stringify(command)}`
}

function admits(pattern: string, command: string): boolean {
  if (!pattern.endsWith(':*')) return command === pattern
  const prefix = pattern.slice(0, -2)
  return command === prefix || command.startsWith(`${prefix} `)
}

function deny(reason: string): SyncHookJSONOutput {
  return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

function stop(reason: string): SyncHookJSONOutput {
  return {
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }
}

export function fired(message: SDKResultMessage, started: number, refused: string[]): Omit<Fired, 'transcript_path'> {
  const usage = Object.values(message.modelUsage).reduce(
    (n, u) => ({
      input: n.input + u.inputTokens + u.cacheCreationInputTokens,
      cache: n.cache + u.cacheReadInputTokens,
      output: n.output + u.outputTokens,
    }),
    { input: 0, cache: 0, output: 0 },
  )
  const denials = refused.length + message.permission_denials.length
  const ended = message.terminal_reason ?? (refused.length > 0 ? 'hook_stopped' : 'completed')
  const text = message.subtype === 'success' ? message.result : message.errors.join('\n')
  const stopped = message.is_error || ended !== 'completed'
  return {
    text: text === '' ? refused.join('\n') : text,
    usage,
    seconds: (Date.now() - started) / 1000,
    ended: stopped ? 'stopped' : 'completed',
    exit: stopped ? 1 : 0,
    stop_reason: refused[0] ?? (ended === 'completed' ? message.stop_reason : ended),
    denials,
  }
}
