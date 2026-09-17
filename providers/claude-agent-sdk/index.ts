import { query, type HookInput, type SDKResultMessage, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import type { Fired, Packet, Provider } from '../kind.ts'

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit'])

export const claudeAgentSdk: Provider = { name: 'claude-agent-sdk', fire }

async function fire(packet: Packet): Promise<Fired> {
  const started = Date.now()
  const run = query({
    prompt: packet.prompt,
    options: {
      cwd: packet.cwd,
      model: packet.model,
      effort: packet.effort,
      allowedTools: packet.tools,
      settingSources: [],
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [(input) => Promise.resolve(gate(packet, input))] }] },
    },
  })
  for await (const message of run) {
    if (message.type === 'result') return fired(message, started)
  }
  throw new Error('claude-agent-sdk closed without a result message')
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

function fired(message: SDKResultMessage, started: number): Fired {
  const usage = Object.values(message.modelUsage).reduce(
    (n, u) => ({
      input: n.input + u.inputTokens,
      cache: n.cache + u.cacheReadInputTokens + u.cacheCreationInputTokens,
      output: n.output + u.outputTokens,
    }),
    { input: 0, cache: 0, output: 0 },
  )
  return {
    text: message.subtype === 'success' ? message.result : message.errors.join('\n'),
    usage,
    seconds: (Date.now() - started) / 1000,
    exit: message.is_error ? 1 : 0,
  }
}
