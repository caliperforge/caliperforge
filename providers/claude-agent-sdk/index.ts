import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { query, type HookInput, type SDKResultMessage, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Fired, Packet, Provider } from '../kind.ts'

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit'])

export const claudeAgentSdk: Provider = { name: 'claude-agent-sdk', fire }

async function fire(packet: Packet): Promise<Fired> {
  const started = Date.now()
  const refused: string[] = []
  const transcript = openTranscript(packet)
  const run = query({
    prompt: packet.prompt,
    options: {
      cwd: packet.cwd,
      model: packet.model,
      effort: packet.effort,
      allowedTools: packet.tools,
      settingSources: [],
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [(input) => {
        const decision = gate(packet, input)
        if (decision.stopReason !== undefined) refused.push(decision.stopReason)
        return Promise.resolve(decision)
      }] }] },
    },
  })
  for await (const message of run) {
    transcript(message)
    if (message.type === 'result') return { ...fired(message, started, refused), transcript_path: packet.transcript }
  }
  throw new Error('claude-agent-sdk closed without a result message')
}

/** The stream as it arrived, one JSON message per line, before any reading of it. */
function openTranscript(packet: Packet): (message: unknown) => void {
  mkdirSync(dirname(packet.transcript), { recursive: true })
  writeFileSync(packet.transcript, '')
  return (message) => { appendFileSync(packet.transcript, `${JSON.stringify(message)}\n`) }
}

export function gate(packet: Packet, input: HookInput): SyncHookJSONOutput {
  const path = input.hook_event_name === 'PreToolUse' && WRITES.has(input.tool_name)
    ? (input.tool_input as { file_path?: unknown }).file_path
    : undefined
  if (typeof path !== 'string') return { continue: true }
  const refusal = packet.refuse(path)
  if (refusal === null) return { continue: true }
  const reason = `${refusal.origin_kind}:${refusal.origin_ref} refuses a write to ${refusal.path}`
  return {
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }
}

export function fired(message: SDKResultMessage, started: number, refused: string[]): Omit<Fired, 'transcript_path'> {
  const usage = Object.values(message.modelUsage).reduce(
    (n, u) => ({
      input: n.input + u.inputTokens,
      cache: n.cache + u.cacheReadInputTokens + u.cacheCreationInputTokens,
      output: n.output + u.outputTokens,
    }),
    { input: 0, cache: 0, output: 0 },
  )
  const denials = refused.length + message.permission_denials.length
  const ended = message.terminal_reason ?? (denials > 0 ? 'hook_stopped' : 'completed')
  const text = message.subtype === 'success' ? message.result : message.errors.join('\n')
  return {
    text: text === '' ? refused.join('\n') : text,
    usage,
    seconds: (Date.now() - started) / 1000,
    exit: message.is_error || ended !== 'completed' ? 1 : 0,
    stop_reason: refused[0] ?? (ended === 'completed' ? message.stop_reason : ended),
    denials,
  }
}
