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
  refuse: (path: string) => Refusal | null
}

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
