import type { HookCallback, HookInput, Options } from '@anthropic-ai/claude-agent-sdk'

/** Bash in the sandbox with no host allowed and no unsandboxed retry; a sandbox that cannot start ends the run with an error result. */
export function sealed(tmp: string | undefined): Pick<Options, 'sandbox' | 'canUseTool'> {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true },
      ...(tmp === undefined ? {} : { filesystem: { allowWrite: [tmp] } }) },
    canUseTool: (tool) => Promise.resolve({ behavior: 'deny', message: `ruling:run.offline refuses ${tool}: an offline run is asked nothing` }),
  }
}

/** Every host is refused on an offline run, so a Bash call that failed to reach one met the sandbox. */
const UNREACHED = /CONNECT tunnel failed|blocked-by-allowlist|Could not resolve host|Failed to connect to|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/

export function cut(offline: string[]): Options['hooks'] {
  const seen: HookCallback = (input) => {
    const command = unreached(input)
    if (command !== null) offline.push(command)
    return Promise.resolve({ continue: true })
  }
  return { PostToolUse: [{ matcher: 'Bash', hooks: [seen] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [seen] }] }
}

function unreached(input: HookInput): string | null {
  if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return null
  const said = input.hook_event_name === 'PostToolUse' ? input.tool_response : input.error
  const command = (input.tool_input as { command?: unknown }).command
  return typeof command === 'string' && UNREACHED.test(JSON.stringify(said)) ? command : null
}
