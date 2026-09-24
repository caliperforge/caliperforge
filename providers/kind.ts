import type { TerminalReason } from '@anthropic-ai/claude-agent-sdk'
import type { Reading } from '../store/lanes.ts'

export interface Refusal {
  origin_kind: 'rail' | 'ruling' | 'incident'
  origin_ref: string
  path: string
}

export interface Packet {
  prompt: string
  cwd: string
  transcript: string
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  tools: string[]
  /** The run's turn ceiling; a packet without one runs unbounded. */
  steps?: number
  /** #148: what this one run may spend before it stops, cache reads left out. A packet without one is unwalled. */
  wall?: number
  refuse: (path: string) => Refusal | null
}

/** `stop_reason` is the SDK's `terminal_reason` verbatim, so the refire keys on the SDK's own spelling. */
export const CAPPED: Extract<TerminalReason, 'max_turns'> = 'max_turns'

/** `Bash(gradle:*)` is still Bash: a tool's permission pattern does not change which tool it is. */
export function bare(tool: string): string {
  return tool.split('(')[0] ?? tool
}

export interface Fired {
  text: string
  transcript_path: string
  usage: { input: number; cache: number; output: number }
  seconds: number
  exit: number
  stop_reason: string | null
  denials: number
  /** The subscription windows the provider reported during the run (#104): what the usage band steps the lanes by. */
  limits?: Reading[]
}

export interface Provider {
  name: 'claude-agent-sdk' | 'anthropic-api' | 'deepseek'
  fire: (packet: Packet) => Promise<Fired>
}
