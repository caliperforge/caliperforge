import type { Packet } from '../providers/kind.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'

const RESTATE = 'Restate the verdict above in the fence your instructions give, and nothing else.'

export function again(db: Db, plan: number, name: string, packet: Packet, first: { run: number; text: string; capped: boolean }): Packet {
  if (first.capped) return { ...packet, tools: [] }
  logged(db, { plan, kind: 'review', actor: name, outcome: 'pass', message: `${name} refired for the verdict fence`, pointer: null, run: first.run })
  return { ...packet, tools: [], prompt: `${packet.prompt}\n\n# Your answer\n\n${first.text}\n\n${RESTATE}` }
}
