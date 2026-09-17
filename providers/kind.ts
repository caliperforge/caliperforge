export interface Refusal {
  outcome: 'refuse'
  origin_kind: 'rail' | 'ruling' | 'incident'
  origin_ref: string
  path: string
}

export interface Packet {
  prompt: string
  cwd: string
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  tools: string[]
  refuse: (path: string) => Refusal | null
}

export interface Fired {
  text: string
  usage: { input: number; cache: number; output: number }
  seconds: number
  exit: number
}

export interface Provider {
  name: 'claude-agent-sdk' | 'anthropic-api' | 'deepseek'
  fire: (packet: Packet) => Promise<Fired>
}
